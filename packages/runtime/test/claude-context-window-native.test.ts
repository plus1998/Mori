import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkDriver, type ClaudeAgentSdkModule } from "../src/claude-agent-sdk";

// Exercises separate real CLI processes and their context control-channel reports.
// The upstream is local; no remote credentials or long model generation are needed.
test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native Claude sessions independently report their resolved context window and compact threshold",
  async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "eco-claude-context-"));
    const inherited = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    const windows = [262_144, 524_288];
    const requests: string[] = [];
    let releaseRequests: () => void = () => {};
    const bothRequests = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
        if (!pathname.endsWith("/messages")) return Response.json({ ok: true });
        const body = (await request.json()) as { model: string; stream?: boolean };
        requests.push(body.model);
        if (requests.length === 2) releaseRequests();
        await bothRequests;
        const message = {
          id: `msg_context_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "CONTEXT_SESSION_OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        };
        if (!body.stream) return Response.json(message);
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "CONTEXT_SESSION_OK" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      releaseRequests();
      controller.abort();
    }, 25_000);
    try {
      const reports = await Promise.all(
        windows.map(async (contextWindow) => {
          let report: Record<string, unknown> | undefined;
          const driver = new ClaudeAgentSdkDriver({
            apiKey: "local-context-test",
            baseUrl: server.url.origin,
            loadSdk: async () =>
              ({
                query: ({ prompt, options }) => {
                  const env: Record<string, string> = {
                    ...(options.env as Record<string, string>),
                    CLAUDE_CONFIG_DIR: path.join(workspace, `config-${contextWindow}`),
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                  };
                  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
                  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
                  delete env.DISABLE_COMPACT;
                  delete env.DISABLE_AUTO_COMPACT;
                  return query({ prompt: prompt as never, options: { ...options, env } as never });
                },
              }) as ClaudeAgentSdkModule,
          });
          let terminal = false;
          for await (const event of driver.runAsk({
            threadId: `thr_native_context_${contextWindow}`,
            prompt: "Reply CONTEXT_SESSION_OK",
            workspacePath: workspace,
            worktreePath: workspace,
            routes: [
              {
                role: "planner",
                primary: {
                  id: "custom",
                  provider: "custom",
                  displayName: "Custom context test",
                  baseUrl: server.url.origin,
                  modelId: "eco-context-session-native",
                  capabilities: ["messages_api"],
                  enabled: true,
                  contextWindow,
                },
                fallbacks: [],
                maxOutputTokens: 32_000,
              },
            ],
            sdkSession: { settingSources: [] },
            signal: controller.signal,
          })) {
            const payload = event.payload as Record<string, unknown> | undefined;
            if (payload?.type === "sdk_context_usage")
              report = payload.ecoSdkContextUsage as Record<string, unknown>;
            if (event.type === "run.terminal") terminal = true;
          }
          expect(terminal).toBe(true);
          expect(report).toMatchObject({
            maxTokens: contextWindow,
            rawMaxTokens: contextWindow,
            autoCompactThreshold: contextWindow - 20_000 - 13_000,
            isAutoCompactEnabled: true,
          });
          return {
            contextWindow,
            sdkWindow: report?.maxTokens,
            compactThreshold: report?.autoCompactThreshold,
          };
        }),
      );
      expect(requests).toEqual(["eco-context-session-native", "eco-context-session-native"]);
      expect(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(inherited);
      console.log(JSON.stringify({ nativeContextSessionIsolation: reports }));
    } finally {
      clearTimeout(timer);
      releaseRequests();
      controller.abort();
      server.stop(true);
      await rm(workspace, { recursive: true, force: true });
    }
  },
  30_000,
);
