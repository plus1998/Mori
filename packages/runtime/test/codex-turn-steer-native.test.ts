import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import { syncCodexConfigFromEcoProviders } from "../src/codex-config-sync";
import { CodexEventAdapter, type CodexThreadRunEventInput } from "../src/codex-event-adapter";
import { steerCodexTurn } from "../src/codex-turn-steer";

// Real bundled app-server, isolated home, and a loopback Responses API.
for (const preempt of [true, false]) {
  test.skipIf(process.env.ECO_CODEX_NATIVE_SMOKE !== "1")(
    `native steer records the correct output boundary (instant_interrupt=${preempt})`,
    async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "mori-codex-steer-"));
      const releaseFirst = Promise.withResolvers<void>();
      const oldDelta = Promise.withResolvers<void>();
      const terminal = Promise.withResolvers<string>();
      const requests: unknown[][] = [];
      const projected: CodexThreadRunEventInput[] = [];
      const encoder = new TextEncoder();
      let firstCancelled = false;
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json() as { model: string; input: unknown[] };
          const index = requests.push(body.input);
          const first = index === 1;
          const prefix = first ? "Original output " : "Output after steering.";
          const text = first ? `${prefix}finished.` : prefix;
          const item = {
            id: `msg_fixture_${index}`,
            type: "message",
            role: "assistant",
            phase: first ? "commentary" : "final_answer",
          };
          const done = { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
          const response = {
            id: `resp_fixture_${index}`, object: "response", model: body.model,
            status: "completed", output: [done],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
          return new Response(new ReadableStream({
            async start(controller) {
              const send = (type: string, payload: Record<string, unknown>) => {
                const data = JSON.stringify({ type, ...payload });
                controller.enqueue(encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
              };
              const delta = (value: string) => send("response.output_text.delta", {
                output_index: 0, content_index: 0, item_id: item.id, delta: value,
              });
              send("response.created", { response: { ...response, status: "in_progress", output: [] } });
              send("response.output_item.added", {
                output_index: 0, item: { ...item, status: "in_progress", content: [] },
              });
              delta(prefix);
              if (first) {
                await releaseFirst.promise;
                if (firstCancelled) return;
                delta(text.slice(prefix.length));
              }
              send("response.output_item.done", { output_index: 0, item: done });
              send("response.completed", { response });
              controller.close();
            },
            cancel() { if (first) firstCancelled = true; },
          }), { headers: { "content-type": "text/event-stream" } });
        },
      });
      let client: CodexAppServerClient | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let stderr = "";
      const deadline = setTimeout(() => {
        oldDelta.reject(new Error("Codex did not stream the original answer."));
        terminal.resolve("timed out");
      }, 12_000);
      void oldDelta.promise.catch(() => {});
      try {
        const config = await syncCodexConfigFromEcoProviders({
          ecoDataDir: workspace,
          gatewayBaseUrl: `http://127.0.0.1:${api.port}/v1`,
          providers: [{ id: "fixture", name: "Loopback", enabled: true }],
        });
        const executable = path.resolve(import.meta.dir, "../../../apps/desktop/node_modules/.bin/codex");
        const processHandle = spawn(executable, ["app-server", "--stdio", "-c", `features.instant_interrupt=${preempt}`], {
          cwd: workspace,
          env: { PATH: process.env.PATH, CODEX_HOME: config.codexHomeDir, RUST_LOG: "error" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child = processHandle;
        processHandle.once("error", error => oldDelta.reject(error));
        processHandle.stderr.on("data", chunk => { stderr += String(chunk); });
        const adapter = new CodexEventAdapter({
          resolveEcoThreadId: () => "mori",
          recordThreadRunEvent: event => projected.push(event),
        });
        client = CodexAppServerClient.attachToProcess(processHandle, {
          timeoutMs: 5_000,
          onNotification(method, params) {
            adapter.dispatch(method, params);
            if (method === "item/agentMessage/delta" && projected.at(-1)?.streamKey === "msg_fixture_1") {
              oldDelta.resolve();
            }
            if (method === "turn/completed") terminal.resolve(projected.at(-1)?.eventType ?? "missing terminal");
          },
        });
        await client.initialize({
          clientInfo: { name: "mori-steer-smoke", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        const { thread } = await client.request<{ thread: { id: string } }>("thread/start", {
          cwd: workspace, model: "gpt-5", modelProvider: "eco_fixture",
          approvalPolicy: "never", sandbox: "read-only",
        });
        const { turn } = await client.request<{ turn: { id: string } }>("turn/start", {
          threadId: thread.id, input: [{ type: "text", text: "Start" }],
        });
        await oldDelta.promise;
        await steerCodexTurn(client, {
          threadId: thread.id, turnId: turn.id, clientUserMessageId: "fixture-steer",
          input: [{ type: "text", text: "Change direction" }],
        });
        if (!preempt) {
          expect(projected.some(event => event.metadata?.clientUserMessageId === "fixture-steer")).toBe(false);
          releaseFirst.resolve();
        }
        expect(await terminal.promise).toBe("run.attempt.completed");
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1])).toContain("Change direction");
        const boundary = projected.filter(event =>
          (event.streamKey === "msg_fixture_1" && event.eventType === "message.final") ||
          event.metadata?.clientUserMessageId === "fixture-steer" ||
          (event.streamKey === "msg_fixture_2" && event.eventType === "message.delta")
        );
        expect(boundary.map(event => [event.eventType, event.role])).toEqual([
          ["message.final", "assistant"], ["message.final", "user"], ["message.delta", "assistant"],
        ]);
        expect(boundary[0]?.metadata?.codexOutputInterrupted === true).toBe(preempt);
        expect(boundary[0]?.message).toBe(preempt ? "" : "Original output finished.");
      } catch (error) {
        throw new Error(`Codex steer smoke failed\n${stderr}`, { cause: error });
      } finally {
        clearTimeout(deadline);
        releaseFirst.resolve();
        client?.close();
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
        await api.stop(true);
        await rm(workspace, { recursive: true, force: true });
      }
    },
    20_000,
  );
}
