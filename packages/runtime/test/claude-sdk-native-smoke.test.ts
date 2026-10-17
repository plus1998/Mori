import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkModule,
  type ClaudeQueryHandle,
  createHeldPromptStream,
} from "../src/claude-agent-sdk";

test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native Stop terminates an in-flight Bash child before it can write another file",
  async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "eco-claude-stop-"));
    const startedFile = path.join(workspace, "started");
    const finishedFile = path.join(workspace, "finished");
    const controller = new AbortController();
    const command = `node -e 'require("fs").writeFileSync("${startedFile}", "started"); setTimeout(() => require("fs").writeFileSync("${finishedFile}", "finished"), 2500)'`;
    let calls = 0;
    let runError: unknown;
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
        if (!pathname.endsWith("/messages")) return Response.json({ ok: true });
        const body = (await request.json()) as { model: string; stream?: boolean };
        const call = ++calls;
        const block =
          call === 1
            ? { type: "tool_use", id: "stop-bash", name: "Bash", input: { command } }
            : { type: "text", text: "done" };
        const message = {
          id: `msg_stop_${call}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [block],
          stop_reason: call === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        };
        if (!body.stream) return Response.json(message);
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          {
            type: "content_block_start",
            index: 0,
            content_block: block.type === "tool_use" ? { ...block, input: {} } : { ...block, text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta:
              block.type === "tool_use"
                ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
                : { type: "text_delta", text: "done" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
    });
    const driver = new ClaudeAgentSdkDriver({
      apiKey: "local-stop-test",
      baseUrl: server.url.origin,
      loadSdk: async () =>
        ({
          query: ({ prompt, options }) =>
            query({
              prompt: prompt as never,
              options: {
                ...options,
                tools: ["Bash"],
                allowedTools: ["Bash"],
                settingSources: [],
                env: {
                  ...process.env,
                  ...(options.env as Record<string, string>),
                  CLAUDE_CONFIG_DIR: path.join(workspace, "config"),
                  ANTHROPIC_AUTH_TOKEN: "",
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                },
              } as never,
            }),
        }) as unknown as ClaudeAgentSdkModule,
    });
    const run = (async () => {
      for await (const _event of driver.run({
        threadId: "thr_native_stop",
        prompt: "Run the provided Bash command.",
        workspacePath: workspace,
        worktreePath: workspace,
        routes: [
          { role: "planner", primary: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" } },
        ],
        signal: controller.signal,
      })) {
        seen.push(_event.type);
      }
    })().catch((error: unknown) => {
      runError = error;
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(startedFile) && Date.now() < deadline) await Bun.sleep(25);
      if (!existsSync(startedFile))
        throw new Error(
          `Bash did not start: calls=${calls}, events=${seen.join(",")}, error=${String(runError)}`,
        );
      const stoppedAt = Date.now();
      controller.abort("cancelled by user");
      await run;
      const elapsedMs = Date.now() - stoppedAt;
      console.log(`Native Bash Stop settled in ${elapsedMs}ms`);
      expect(elapsedMs).toBeLessThan(1500);
      await Bun.sleep(2700);
      expect(existsSync(finishedFile)).toBe(false);
      expect(calls).toBe(1);
    } finally {
      controller.abort("test cleanup");
      await run;
      server.stop(true);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  30_000,
);

// Runs the installed native Claude Code binary against a local Messages server,
// exercising the real SDK control channel without credentials or remote model calls.
test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native SDK streams tools, hooks, MCP and resumed/forked cumulative usage",
  async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "eco-claude-native-"));
    let call = 0;
    let mcpCalls = 0;
    let permissionCalls = 0;
    const permissionTools = new Set<string>();
    let hookCalls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("count_tokens"))
          return Response.json({ input_tokens: 100 });
        if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ ok: true });
        const body = (await request.json()) as { model: string; stream?: boolean };
        const index = ++call;
        const block =
          index === 1
            ? {
                type: "tool_use",
                id: "native-bash",
                name: "Bash",
                input: {
                  command: "node -e 'process.stdout.write(\"ECO_NATIVE_PERMISSION\")'",
                  description: "Native regression probe",
                },
              }
            : index === 2
              ? {
                  type: "tool_use",
                  id: "native-mcp",
                  name: "mcp__native_smoke__echo",
                  input: { text: "ECO_NATIVE_MCP" },
                }
              : { type: "text", text: "ECO_NATIVE_OK" };
        const stopReason = block.type === "tool_use" ? "tool_use" : "end_turn";
        const message = {
          id: `msg_native_${index}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [block],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
        if (!body.stream) return Response.json(message);
        const events = [
          {
            type: "message_start",
            message: {
              ...message,
              content: [],
              stop_reason: null,
              usage: { ...message.usage, output_tokens: 0 },
            },
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
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(workspace, "config"),
      ANTHROPIC_BASE_URL: server.url.origin,
      ANTHROPIC_API_KEY: "local-native-test",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    const mcpServer = createSdkMcpServer({
      name: "native_smoke",
      tools: [
        tool("echo", "Echo regression marker", { text: z.string() }, async ({ text }) => {
          mcpCalls += 1;
          return { content: [{ type: "text", text }] };
        }),
      ],
    });
    async function run(resume?: string, forkSession?: boolean, resumeSessionAt?: string) {
      const prompt = createHeldPromptStream("Run native regression", { uuid: crypto.randomUUID() });
      const session = query({
        prompt: prompt as never,
        options: {
          cwd: workspace,
          env,
          settingSources: [],
          model: "claude-sonnet-4-20250514",
          permissionMode: "default",
          tools: ["Bash"],
          allowedTools: ["mcp__native_smoke__echo"],
          includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code", snapshot: false },
          mcpServers: {
            native_smoke: {
              ...mcpServer,
              tools: [{ name: "echo", permission_policy: "always_ask" }],
            },
          },
          canUseTool: async (name, input) => {
            permissionCalls += 1;
            permissionTools.add(name);
            expect(input).not.toHaveProperty("eco_unknown_argument");
            if (name === "Bash") expect(input.command).toContain("ECO_NATIVE_HOOK_NORMALIZED");
            return { behavior: "allow", updatedInput: input };
          },
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    hookCalls += 1;
                    if (input.hook_event_name === "PreToolUse" && input.tool_name === "Bash") {
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          updatedInput: {
                            ...input.tool_input,
                            command: "node -e 'process.stdout.write(\"ECO_NATIVE_HOOK_NORMALIZED\")'",
                            eco_unknown_argument: "must be stripped before approval and execution",
                          },
                        },
                      };
                    }
                    return {};
                  },
                ],
              },
            ],
          },
          ...(resume && { resume }),
          ...(forkSession && { forkSession }),
          ...(resumeSessionAt && { resumeSessionAt }),
        },
      });
      const messages: Record<string, unknown>[] = [];
      try {
        for await (const message of session) {
          messages.push(message as unknown as Record<string, unknown>);
          if (message.type === "result") prompt.close();
        }
      } finally {
        prompt.close();
        session.close();
      }
      const result = messages.findLast((message) => message.type === "result");
      if (!result) throw new Error("Native SDK did not emit a result");
      expect(result).toMatchObject({ subtype: "success", is_error: false });
      expect(
        messages.some(
          (message) =>
            message.type === "stream_event" &&
            (message.event as Record<string, unknown>)?.type === "message_stop",
        ),
      ).toBe(true);
      return result;
    }
    try {
      const first = await run();
      expect(permissionCalls).toBeGreaterThan(0);
      expect([...permissionTools].sort()).toEqual(["Bash", "mcp__native_smoke__echo"]);
      expect(hookCalls).toBe(2);
      expect(mcpCalls).toBe(1);
      const resumed = await run(first.session_id as string);
      const forked = await run(resumed.session_id as string, true);
      const totals = [first, resumed, forked].map((result) =>
        Object.values(result.modelUsage as Record<string, { inputTokens: number }>).reduce(
          (sum, model) => sum + model.inputTokens,
          0,
        ),
      );
      expect(totals).toEqual([300, 400, 500]);
      expect(Number(resumed.total_cost_usd)).toBeGreaterThan(Number(first.total_cost_usd));
      expect(Number(forked.total_cost_usd)).toBeGreaterThan(Number(resumed.total_cost_usd));
      expect(forked.session_id).not.toBe(resumed.session_id);
      let liveHandle: ClaudeQueryHandle | undefined;
      const driver = new ClaudeAgentSdkDriver({
        queryLifecycle: {
          onOpen: (handle) => {
            liveHandle = handle;
          },
        },
        apiKey: "local-native-test",
        baseUrl: server.url.origin,
        loadSdk: async () =>
          ({
            query: ({ prompt, options }) =>
              query({
                prompt: prompt as never,
                options: {
                  ...options,
                  env: {
                    ...(options.env as Record<string, string>),
                    ...env,
                    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
                  },
                } as never,
              }),
          }) as unknown as ClaudeAgentSdkModule,
      });
      async function ecoRun(
        prompt: string,
        resumeSessionId?: string,
        injectFollowUp = false,
        newSessionId?: string,
      ) {
        const events = [];
        let pushed = false;
        for await (const event of driver.runAsk({
          threadId: "thr_native_eco",
          prompt,
          workspacePath: workspace,
          worktreePath: workspace,
          routes: [
            {
              role: "planner",
              primary: { provider: "anthropic", modelId: "claude-sonnet-4-20250514", contextWindow: 200_000 },
            },
          ],
          ...(resumeSessionId && { resume: { resumeSessionId } }),
          ...(newSessionId && { resume: { newSessionId } }),
          signal: new AbortController().signal,
        })) {
          events.push(event);
          if (injectFollowUp && !pushed && event.type === "session.captured") {
            pushed = true;
            if (!liveHandle) throw new Error("Native Eco query handle is missing");
            await liveHandle.pushUserMessage("Native Eco follow-up", {
              uuid: "tfu_00000000-0000-4000-8000-000000000289",
            });
          }
        }
        const terminal = events.findLast((event) => event.type === "run.terminal");
        expect(terminal?.payload).toMatchObject({ status: "completed" });
        return events;
      }
      const ecoFirst = await ecoRun("Native Eco adapter");
      const firstUsage = ecoFirst.find(
        (event) =>
          event.type === "usage.recorded" && (event.payload as Record<string, unknown>).type === "result",
      )?.payload as Record<string, unknown>;
      const ecoSessionId = (firstUsage.sdk_session_usage as { sessionId: string }).sessionId;
      expect(firstUsage.sdk_session_usage).toMatchObject({ resumed: false });
      const ecoResumed = await ecoRun("Resume native Eco adapter", ecoSessionId, true);
      const forkAtFollowUp = await run(ecoSessionId, true, "00000000-0000-4000-8000-000000000289");
      expect(forkAtFollowUp.session_id).not.toBe(ecoSessionId);
      expect(
        ecoResumed.find(
          (event) =>
            event.type === "usage.recorded" && (event.payload as Record<string, unknown>).type === "result",
        )?.payload,
      ).toMatchObject({ sdk_session_usage: { sessionId: ecoSessionId, resumed: true } });
      const ecoReset = await ecoRun("/clear", ecoSessionId);
      const reset = ecoReset.find(
        (event) => (event.payload as Record<string, unknown>)?.type === "conversation_reset",
      );
      expect(reset).toBeDefined();
      if (!reset) throw new Error("Native SDK did not reset the conversation");
      expect(ecoReset.findLast((event) => event.type === "session.captured")?.payload).toMatchObject({
        sessionId: (reset.payload as Record<string, unknown>).new_conversation_id,
        resetPending: true,
      });
      expect(
        ecoReset.find(
          (event) =>
            event.type === "usage.recorded" && (event.payload as Record<string, unknown>).type === "result",
        )?.payload,
      ).toMatchObject({ sdk_session_usage: { resumed: false } });
      // The clear-only Query has closed. Its allocated ID has no transcript:
      // initialize that ID, then verify the following Query can truly resume it.
      const resetSessionId = (reset.payload as Record<string, unknown>).new_conversation_id as string;
      const afterClear = await ecoRun("First persisted turn after clear", undefined, false, resetSessionId);
      const afterClearCaptures = afterClear.filter((event) => event.type === "session.captured");
      expect(afterClearCaptures[0]?.payload).toMatchObject({ sessionId: resetSessionId, resetPending: true });
      expect(afterClearCaptures.at(-1)?.payload).toEqual({ sessionId: resetSessionId, cwd: workspace });
      const afterClearUsage = afterClear.find(
        (event) =>
          event.type === "usage.recorded" && (event.payload as Record<string, unknown>).type === "result",
      )?.payload;
      expect(afterClearUsage).toMatchObject({
        sdk_session_usage: { sessionId: resetSessionId, resumed: false },
      });
      const afterClearResumed = await ecoRun("Resume the persisted post-clear conversation", resetSessionId);
      expect(
        afterClearResumed.find(
          (event) =>
            event.type === "usage.recorded" && (event.payload as Record<string, unknown>).type === "result",
        )?.payload,
      ).toMatchObject({
        sdk_session_usage: { sessionId: resetSessionId, resumed: true },
      });
      console.log(
        `[native-sdk] permission=${permissionCalls} hooks=${hookCalls} mcp=${mcpCalls} inputTotals=${totals.join(",")}`,
      );
    } finally {
      server.stop(true);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native SDK first request respects skill selection and Eco tool visibility in every mode",
  async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "eco-claude-visibility-"));
    for (const name of ["selected-audit", "disabled-audit"]) {
      const directory = path.join(workspace, ".claude", "skills", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ECO_VISIBILITY_${name} marker.\n---\nTest fixture.\n`,
      );
    }
    const requests: Array<{ model: string; stream?: boolean; tools?: Array<{ name: string }> }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
        if (!pathname.endsWith("/messages")) return Response.json({ ok: true });
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
        const message = {
          id: `msg_visibility_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "VISIBILITY_OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        };
        if (!body.stream) return Response.json(message);
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "VISIBILITY_OK" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const driver = new ClaudeAgentSdkDriver({
      apiKey: "local-visibility-test",
      baseUrl: server.url.origin,
      toolPermissionHandler: async () => ({ behavior: "allow" }),
      loadSdk: async () => ({
        query: ({ prompt, options }) =>
          query({
            prompt: prompt as never,
            options: {
              ...options,
              env: {
                ...(options.env as Record<string, string>),
                CLAUDE_CONFIG_DIR: path.join(workspace, "config"),
                ANTHROPIC_AUTH_TOKEN: "",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              },
            } as never,
          }),
      }),
    });
    try {
      for (const mode of ["agent", "ask", "plan"] as const) {
        requests.length = 0;
        const input = {
          threadId: `thr_visibility_${mode}`,
          prompt: "Reply VISIBILITY_OK.",
          workspacePath: workspace,
          worktreePath: workspace,
          routes: [
            {
              role: "planner",
              primary: { provider: "anthropic", modelId: "claude-sonnet-4-20250514", contextWindow: 200_000 },
            },
          ],
          sdkSession: {
            settingSources: ["project"] as ["project"],
            skills: mode === "ask" ? ["selected-audit"] : [],
          },
          signal: new AbortController().signal,
        };
        const run =
          mode === "plan"
            ? driver.runContinuation(input, "planning")
            : mode === "ask"
              ? driver.runAsk(input)
              : driver.run(input);
        for await (const _event of run) {
          /* drain the real SDK */
        }
        const first = requests.find((request) => (request.tools?.length ?? 0) > 0);
        expect(first).toBeDefined();
        expect(JSON.stringify(first)).not.toContain("ECO_VISIBILITY_disabled-audit");
        if (mode === "ask") expect(JSON.stringify(first)).toContain("ECO_VISIBILITY_selected-audit");
        else expect(JSON.stringify(first)).not.toContain("ECO_VISIBILITY_selected-audit");
        const names = first?.tools?.map((tool) => tool.name) ?? [];
        expect(names).toContain("Read");
        expect(names).toContain("WebSearch");
        for (const tool of [
          "CronCreate",
          "CronDelete",
          "CronList",
          "ScheduleWakeup",
          "ReportFindings",
          "EnterWorktree",
          "ExitWorktree",
        ]) {
          expect(names).not.toContain(tool);
        }
        if (mode === "ask") {
          expect(names).not.toContain("Bash");
          expect(names).not.toContain("Write");
        } else {
          expect(names).toContain("Bash");
          expect(names).toContain("Write");
        }
        if (mode === "plan") expect(names).toContain("ExitPlanMode");
        else expect(names).not.toContain("ExitPlanMode");
      }
    } finally {
      server.stop(true);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60_000,
);
