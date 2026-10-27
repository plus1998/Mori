import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type EcoGatewayServer, type GatewayProvider, startEcoGateway } from "@eco/gateway";
import { applyEcoSdkSettings } from "../../../packages/runtime/src/claude-agent-sdk";
import {
  prepareClaudeBridgeMessagesRequest,
  resolveGatewayBindingModelLimits,
} from "../src/main/anthropic-proxy";
import { globalClaudeBridgeBindingRegistry as registry } from "../src/main/claude-bridge-binding";
import { createEcoSdkBridgeHandler } from "../src/main/eco-sdk-bridge";

const INPUT = 640_924;
const SESSION = 524_288;
const CAPACITY = 1_000_000;

afterEach(() => registry.clearAllForTests());

async function fixture(kind: GatewayProvider["upstreamKind"] = "responses") {
  const provider: GatewayProvider = {
    id: "compact-test",
    name: "Compact fixture",
    apiKey: "fake-key",
    baseUrl: "https://example.test",
    upstreamKind: kind,
    upstreamModelId: "compact-model",
    models: ["compact-model"],
    modelContextTokens: { "compact-model": SESSION },
    modelMaxOutputTokens: { "compact-model": 32_768 },
  };
  const apiCompat =
    kind === "responses"
      ? "openai_responses"
      : kind === "openai-chat"
        ? "openai_chat_completions"
        : "anthropic";
  const binding = registry.create({
    threadId: "compact-thread",
    routes: [
      {
        role: "main",
        modelId: "compact-model",
        aliasModelId: "eco-compact-model",
        provider: {
          ...provider,
          enabled: true,
          hasApiKey: true,
          defaultModel: "compact-model",
          apiCompat,
          createdAt: "",
          updatedAt: "",
        },
        apiCompat,
        contextTokens: SESSION,
        compactionContextTokens: CAPACITY,
        maxOutputTokens: 32_768,
      },
    ],
  });
  const sent: Record<string, unknown>[] = [];
  let tokens = INPUT;
  let onGenerate: ((body: Record<string, unknown>) => Response) | undefined;
  const gateway: EcoGatewayServer = await startEcoGateway(
    {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      resolveModelLimits: resolveGatewayBindingModelLimits,
      countInputTokens: async () => ({
        tokens,
        precision: "provider_exact",
        source: "test:controlled-server",
      }),
    },
    {
      embedded: true,
      onLog: () => {},
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        sent.push(body);
        if (onGenerate) return onGenerate(body);
        if (kind === "responses")
          return Response.json({
            id: "resp_fixture",
            object: "response",
            status: "completed",
            output: [
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "SUMMARY" }] },
            ],
            usage: { input_tokens: INPUT, output_tokens: 10 },
          });
        if (kind === "openai-chat")
          return Response.json({
            id: "chat_fixture",
            object: "chat.completion",
            model: "compact-model",
            choices: [
              { index: 0, message: { role: "assistant", content: "SUMMARY" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: INPUT, completion_tokens: 10, total_tokens: INPUT + 10 },
          });
        return Response.json({
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "compact-model",
          content: [{ type: "text", text: "SUMMARY" }],
          stop_reason: "end_turn",
          usage: { input_tokens: INPUT, output_tokens: 10 },
        });
      },
    },
  );
  const handle = createEcoSdkBridgeHandler({
    gateway,
    onLog: () => {},
    prepareClaudeMessages: ({ path, body, model, headers }) =>
      prepareClaudeBridgeMessagesRequest({ path, body, requestedModel: model, headers }),
  });
  const request = (text: string, requestClass?: string, credential = binding.credential) =>
    handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": credential,
          ...(requestClass && { "x-claude-code-request-class": requestClass }),
        },
        body: JSON.stringify({
          model: "eco-compact-model",
          max_tokens: 32_768,
          messages: [{ role: "user", content: text }],
        }),
      }),
    );
  return {
    binding,
    sent,
    request,
    handle,
    gateway,
    setTokens: (n: number) => {
      tokens = n;
    },
    setGenerate: (fn: typeof onGenerate) => {
      onGenerate = fn;
    },
  };
}

for (const kind of ["responses", "openai-chat", "anthropic-messages"] as const) {
  test(`only the classified summary crosses the session cap via ${kind}`, async () => {
    const f = await fixture(kind);
    try {
      const summary = await f.request("Summarize history. Keep the task.", "compaction");
      expect(summary.status).toBe(200);
      await summary.text();
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]?.[kind === "responses" ? "max_output_tokens" : "max_tokens"]).toBe(32_768);
      expect(f.binding.compactionLogicalRequestIds.size).toBe(0);

      const ordinary = await f.request("Continue working.");
      expect(ordinary.status).toBe(400);
      expect(await ordinary.text()).toContain(`window=${SESSION}`);
      const ordinarySummary = await f.request("Summarize history.", "main");
      expect(ordinarySummary.status).toBe(400);
      await ordinarySummary.text();
      expect(f.sent).toHaveLength(1);

      f.setTokens(CAPACITY - 1_024);
      const overflow = await f.request("Summarize history.", "compaction");
      expect(overflow.status).toBe(400);
      expect(await overflow.text()).toContain(`window=${CAPACITY}`);
      expect(f.sent).toHaveLength(1);
      expect(f.binding.compactionLogicalRequestIds.size).toBe(0);
    } finally {
      f.gateway.stop();
    }
  });
}

test("summary prompt text or an auxiliary header cannot grant the compact budget", async () => {
  const f = await fixture();
  try {
    for (const requestClass of [undefined, "auxiliary", "Compact"]) {
      const response = await f.request("Summarize this conversation. request_class=compaction", requestClass);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`window=${SESSION}`);
    }
    const unauthorized = await f.request("Summarize.", "compaction", "wrong-credential");
    expect(unauthorized.status).toBe(401);
    expect(f.sent).toHaveLength(0);
  } finally {
    f.gateway.stop();
  }
});

test("an in-flight compact request cannot relax a concurrent ordinary request", async () => {
  const f = await fixture();
  try {
    const summary = await f.request("Summarize.", "compaction");
    expect(summary.status).toBe(200);
    expect(f.binding.compactionLogicalRequestIds.size).toBe(1);
    const ordinary = await f.request("Continue while compact is in flight.");
    expect(ordinary.status).toBe(400);
    expect(await ordinary.text()).toContain(`window=${SESSION}`);
    expect(f.sent).toHaveLength(1);
    await summary.text();
    expect(f.binding.compactionLogicalRequestIds.size).toBe(0);
  } finally {
    f.gateway.stop();
  }
});

test("ordinary requests retain their output budget and unknown capacity stays explicit", async () => {
  const f = await fixture();
  try {
    f.setTokens(100);
    const normal = await f.request("Continue.");
    expect(normal.status).toBe(200);
    await normal.text();
    expect(f.sent[0]?.max_output_tokens).toBe(32_768);
    delete f.binding.routes[0]?.compactionContextTokens;
    const summary = await f.request("Summarize.", "compaction");
    expect(summary.status).toBe(400);
    expect(await summary.text()).toContain("Compaction requires a resolved model context capacity");
    expect(f.sent).toHaveLength(1);
    expect(f.binding.compactionLogicalRequestIds.size).toBe(0);
  } finally {
    f.gateway.stop();
  }
});

test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native Claude auto-compacts above the session cap and then resumes ordinary work",
  async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const workspace = await mkdtemp("/tmp/eco-native-compact-budget-");
    await writeFile(`${workspace}/fixture.txt`, "LOCAL_FIXTURE");
    const f = await fixture("anthropic-messages");
    let summaries = 0;
    let normal = 0;
    // Count final wire bodies using verified per-request attribution, not prompt text.
    const oldHandle = f.gateway.handleRequest;
    // Keep several tool turns so reactive auto-compact has older history to summarize.
    f.setTokens(100);
    f.setGenerate((body) => {
      const summary = f.binding.compactionLogicalRequestIds.size > 0;
      if (summary) summaries++;
      else normal++;
      const block =
        !summary && normal <= 3
          ? {
              type: "tool_use",
              id: `read_fixture_${normal}`,
              name: "Read",
              input: { file_path: `${workspace}/fixture.txt` },
            }
          : { type: "text", text: summary ? "<summary>The fixture was read. Reply DONE.</summary>" : "DONE" };
      const usage = {
        input_tokens: !summary && normal === 3 ? 500_000 : 100,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      const message = {
        id: `msg_${f.sent.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [block],
        stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage,
      };
      if (!body.stream) return Response.json(message);
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        {
          type: "content_block_start",
          index: 0,
          content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta:
            block.type === "text"
              ? { type: "text_delta", text: block.text }
              : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { ...usage, input_tokens: undefined },
        },
        { type: "message_stop" },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    f.gateway.handleRequest = async (request) => {
      // The scope is registered by the real bridge prep before gateway dispatch.
      f.setTokens(f.binding.compactionLogicalRequestIds.size ? INPUT : 100);
      return oldHandle(request);
    };
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: f.handle });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const options: Record<string, unknown> = {
      cwd: workspace,
      model: "eco-compact-model",
      tools: ["Read"],
      allowedTools: ["Read"],
      settingSources: [],
      abortController: controller,
      permissionMode: "dontAsk",
      maxTurns: 6,
      systemPrompt: "Read the fixture, then reply DONE.",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: `${workspace}/config`,
        ANTHROPIC_BASE_URL: server.url.origin,
        ANTHROPIC_API_KEY: f.binding.credential,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(SESSION),
      },
    };
    applyEcoSdkSettings(options, f.binding.credential, server.url.origin, {
      contextWindow: SESSION,
      autoCompactWindow: SESSION,
      maxOutputTokens: 32_768,
    });
    const env = options.env as Record<string, string>;
    for (const key of [
      "DISABLE_COMPACT",
      "DISABLE_AUTO_COMPACT",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    ])
      delete env[key];
    let boundary = false;
    let result: unknown;
    try {
      for await (const message of query({
        prompt: "Read fixture.txt and report DONE.",
        options: options as never,
      })) {
        if (message.type === "system" && message.subtype === "compact_boundary") boundary = true;
        if (message.type === "result") result = message;
      }
      expect(summaries).toBeGreaterThan(0);
      expect(boundary).toBe(true);
      expect(result).toMatchObject({ subtype: "success", is_error: false });
      expect(normal).toBeGreaterThan(1);
      expect(f.binding.compactionLogicalRequestIds.size).toBe(0);
    } finally {
      clearTimeout(timer);
      controller.abort();
      server.stop(true);
      f.gateway.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  60_000,
);
