import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentDefinition, type HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedModelRoute } from "../../model-router/src";
import { createHeldPromptStream } from "../src/claude-agent-sdk";
import { applyClaudeSubagentCompactionWindows } from "../src/claude-subagent-compaction";

test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native Claude compacts only the small child, preserves the parent and large child, and reapplies windows after cold resume",
  async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "eco-claude-child-compact-"));
    writeFileSync(path.join(workspace, "fixture.txt"), "Local deterministic compaction fixture.");
    let round = 0,
      mainCalls = 0;
    const childCalls: Record<string, number> = {};
    const requests: Array<{
      round: number;
      model: string;
      summary: boolean;
      marker: boolean;
      messageCount: number;
    }> = [];
    const stopped: Array<{ type: string; path: string }> = [];
    const compactionHooks: string[] = [];
    const parentWindows: number[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("count_tokens"))
          return Response.json({ input_tokens: 100 });
        const body = (await request.json()) as {
          model: string;
          stream?: boolean;
          messages?: unknown[];
          system?: unknown;
        };
        const text = JSON.stringify(body.messages ?? []) + JSON.stringify(body.system);
        const summary =
          /Your task is to create a detailed summary|summariz.{0,60}conversation|summary of the conversation/i.test(
            text,
          );
        requests.push({
          round,
          model: body.model,
          summary,
          marker: text.includes("COMPACTED_CHILD_MARKER"),
          messageCount: body.messages?.length ?? 0,
        });
        const child = body.model === "eco-small" || body.model === "eco-large";
        let block:
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
        if (summary) {
          block = {
            type: "text",
            text: "<summary>COMPACTED_CHILD_MARKER. The fixture was read. Report CHILD_DONE.</summary>",
          };
        } else if (child) {
          const call = (childCalls[body.model] = (childCalls[body.model] ?? 0) + 1);
          block =
            call <= 4
              ? {
                  type: "tool_use",
                  id: `read-${round}-${body.model}-${call}`,
                  name: "Read",
                  input: { file_path: path.join(workspace, "fixture.txt") },
                }
              : { type: "text", text: "CHILD_DONE" };
        } else {
          const call = ++mainCalls;
          block =
            call <= 2
              ? {
                  type: "tool_use",
                  id: `delegate-${round}-${call}`,
                  name: "Agent",
                  input: {
                    subagent_type: call === 1 ? "eco_small" : "eco_large",
                    description: "Test isolated compaction",
                    prompt: "Read fixture.txt and report",
                    run_in_background: false,
                  },
                }
              : { type: "text", text: "MAIN_DONE" };
        }
        // Report realistic context pressure without generating hundreds of KB of filler.
        const inputTokens = summary
          ? 1000
          : child
            ? childCalls[body.model] === 4
              ? 120_000
              : 1000
            : 130_000;
        const usage = {
          input_tokens: inputTokens,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
        const stopReason = block.type === "tool_use" ? "tool_use" : "end_turn";
        const message = {
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [block],
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        };
        if (!body.stream) return Response.json(message);
        const events = [
          {
            type: "message_start",
            message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta:
              block.type === "tool_use"
                ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
                : { type: "text_delta", text: block.text },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const routes: ResolvedModelRoute[] = [
      ["planner", 1_000_000],
      ["small", 128_000],
      ["large", 200_000],
    ].map(([role, contextWindow]) => ({
      role: String(role),
      primary: {
        id: String(role),
        provider: "custom",
        displayName: String(role),
        baseUrl: server.url.origin,
        modelId: role === "planner" ? "eco-parent[1m]" : `eco-${role}`,
        capabilities: ["messages_api"],
        enabled: true,
        contextWindow: Number(contextWindow),
      },
      fallbacks: [],
    }));
    const definitions = applyClaudeSubagentCompactionWindows(
      {
        eco_small: {
          description: "Small-window worker",
          prompt: "Read the fixture and report.",
          model: "eco-small",
          tools: ["Read"],
        },
        eco_large: {
          description: "Large-window worker",
          prompt: "Read the fixture and report.",
          model: "eco-large",
          tools: ["Read"],
        },
      },
      routes,
    ) as Record<string, AgentDefinition>;
    const hook: HookCallback = async (input) => {
      if (input.hook_event_name === "SubagentStop" && ["eco_small", "eco_large"].includes(input.agent_type))
        stopped.push({ type: input.agent_type, path: input.agent_transcript_path });
      if (input.hook_event_name === "PreCompact" || input.hook_event_name === "PostCompact")
        compactionHooks.push(input.hook_event_name);
      return {};
    };
    let sessionId: string | undefined;
    async function run(resume?: string) {
      round++;
      mainCalls = 0;
      childCalls["eco-small"] = 0;
      childCalls["eco-large"] = 0;
      const prompt = createHeldPromptStream("Run both test workers", { uuid: crypto.randomUUID() });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const session = query({
        prompt: prompt as never,
        options: {
          abortController: controller,
          cwd: workspace,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: path.join(workspace, "config"),
            ANTHROPIC_BASE_URL: server.url.origin,
            ANTHROPIC_API_KEY: "local-child-compact",
            ANTHROPIC_AUTH_TOKEN: "",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
          },
          settingSources: [],
          model: "eco-parent[1m]",
          settings: { autoCompactEnabled: true, autoCompactWindow: 1_000_000 },
          tools: ["Agent", "Read"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          agents: definitions,
          maxTurns: 8,
          ...(resume ? { resume } : {}),
          hooks: {
            PreCompact: [{ hooks: [hook] }],
            PostCompact: [{ hooks: [hook] }],
            SubagentStop: [{ hooks: [hook] }],
          },
          stderr: (text) => writeFileSync(path.join(workspace, "stderr.log"), text, { flag: "a" }),
        },
      });
      try {
        for await (const event of session) {
          if (event.type === "system" && event.subtype === "init") sessionId = event.session_id;
          if (event.type === "result") {
            expect(event.subtype).toBe("success");
            parentWindows.push((await session.getContextUsage({ detail: "summary" })).maxTokens);
            prompt.close();
          }
        }
      } finally {
        clearTimeout(timer);
        prompt.close();
        session.close();
      }
    }
    try {
      await run();
      expect(sessionId).toBeTruthy();
      await run(sessionId);
      expect(compactionHooks.filter((type) => type === "PostCompact")).toHaveLength(2);
      expect(requests.filter((request) => request.summary).map((request) => request.model)).toEqual([
        "eco-small",
        "eco-small",
      ]);
      expect(parentWindows).toHaveLength(2);
      expect(parentWindows.every((window) => window > 500_000)).toBe(true);
      for (const round of [1, 2]) {
        expect(
          requests.some(
            (request) =>
              request.round === round && request.model === "eco-small" && !request.summary && request.marker,
          ),
        ).toBe(true);
        expect(
          requests.filter(
            (request) => request.round === round && request.model === "eco-large" && !request.summary,
          ),
        ).toHaveLength(5);
      }
      expect(stopped.filter((agent) => agent.type === "eco_small")).toHaveLength(2);
      expect(stopped.filter((agent) => agent.type === "eco_large")).toHaveLength(2);
      for (const agent of stopped) {
        const rows = readFileSync(agent.path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(rows.filter((row) => row.subtype === "compact_boundary")).toHaveLength(
          agent.type === "eco_small" ? 1 : 0,
        );
      }
    } finally {
      server.stop(true);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60_000,
);
