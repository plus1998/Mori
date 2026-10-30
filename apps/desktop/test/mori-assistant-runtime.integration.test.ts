import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startEcoGateway } from "@eco/gateway";
import { startEcoSdkBridge } from "../src/main/eco-sdk-bridge";
import { MoriAssistantRuntime } from "../src/main/mori-assistant-runtime";
import type { ChatApiCompat } from "../src/shared/api-compat";
import { DEFAULT_MORI_ASSISTANT_SETTINGS } from "../src/shared/mori-assistant";

const realCodexTest = process.env.ECO_CODEX_REAL_APP_SERVER_TEST === "1" ? test : test.skip;

for (const apiCompat of ["openai_responses", "openai_chat_completions", "anthropic"] as ChatApiCompat[]) {
  realCodexTest(
    `isolated Mori Codex uses ${apiCompat} through Gateway without ChatGPT`,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-custom-codex-"));
      const upstreamRequests: Array<{ path: string; model: string; auth: string | null }> = [];
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const body = (await request.json()) as { model: string };
          upstreamRequests.push({
            path: new URL(request.url).pathname,
            model: body.model,
            auth: request.headers.get("authorization") ?? request.headers.get("x-api-key"),
          });
          return new Response(completedStream(apiCompat), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const gateway = await startEcoGateway(
        {
          host: "127.0.0.1",
          port: 0,
          providers: ["custom", "other"].map((id) => ({
            id,
            name: "Local test",
            baseUrl: `http://127.0.0.1:${upstream.port}`,
            apiKey: "local-test-key",
            upstreamModelId: "custom-model",
            models: ["custom-model"],
            upstreamKind:
              apiCompat === "anthropic"
                ? ("anthropic-messages" as const)
                : apiCompat === "openai_responses"
                  ? ("responses" as const)
                  : ("openai-chat" as const),
          })),
          countInputTokens: async () => ({ tokens: 1, precision: "provider_exact", source: "local-test" }),
        },
        { embedded: true },
      );
      const bridge = await startEcoSdkBridge("127.0.0.1", 0, { gateway });
      const replies: string[] = [];
      const createRuntime = (providerId: string) =>
        new MoriAssistantRuntime({
          executable:
            process.env.CODEX_EXECUTABLE?.trim() || path.resolve("apps/desktop/node_modules/.bin/codex"),
          home: path.join(root, "codex"),
          cwd: path.join(root, "workspace"),
          connection: {
            type: "custom",
            providerId,
            apiCompat,
            gatewayBaseUrl: `${bridge.baseUrl}/v1`,
          },
          resolveSystemProxy: async () => "DIRECT",
          tools: [],
          callTool: async () => {
            throw new Error("No tools expected");
          },
          onText: (_id, text, final) => {
            if (final) replies.push(text);
          },
          onActivity: () => {},
        });
      let runtime = createRuntime("custom");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const settings = {
          ...DEFAULT_MORI_ASSISTANT_SETTINGS,
          modelSource: "custom" as const,
          providerId: "custom",
          model: "custom-model",
        };
        await Promise.race([
          (async () => {
            const nativeId = await runtime.openThread(settings);
            await runtime.send("Reply ok.", settings);
            await runtime.close();
            runtime = createRuntime("other");
            const next = { ...settings, providerId: "other" };
            expect(await runtime.openThread(next, nativeId)).toBe(nativeId);
            await runtime.send("Reply ok again.", next);
          })(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Local Codex smoke timed out")), 20_000);
          }),
        ]);
        expect(replies).toEqual(["ok", "ok"]);
        const expectedRequest = {
          path:
            apiCompat === "anthropic"
              ? "/v1/messages"
              : apiCompat === "openai_responses"
                ? "/v1/responses"
                : "/v1/chat/completions",
          model: "custom-model",
          auth: apiCompat === "anthropic" ? "local-test-key" : "Bearer local-test-key",
        };
        expect(upstreamRequests).toEqual([expectedRequest, expectedRequest]);
        const config = await fs.readFile(path.join(root, "codex", "config.toml"), "utf8");
        expect(config).not.toContain("local-test-key");
        await expect(fs.access(path.join(root, "codex", "auth.json"))).rejects.toThrow();
      } finally {
        clearTimeout(timeout);
        await runtime.close();
        bridge.stop();
        gateway.stop();
        upstream.stop(true);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

function completedStream(apiCompat: ChatApiCompat): string {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  if (apiCompat === "openai_chat_completions") {
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "chat-local", object: "chat.completion.chunk", model: "custom-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return [chunk({ role: "assistant", content: "ok" }, null), chunk({}, "stop"), "data: [DONE]\n\n"].join(
      "",
    );
  }
  if (apiCompat === "anthropic")
    return [
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg-local",
          type: "message",
          role: "assistant",
          model: "custom-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }),
      event("message_stop", { type: "message_stop" }),
    ].join("");
  const message = {
    id: "msg_local",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const response = {
    id: "resp_local",
    object: "response",
    status: "completed",
    model: "custom-model",
    output: [message],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    event("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    }),
    event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message }),
    event("response.completed", { type: "response.completed", response }),
  ].join("");
}
