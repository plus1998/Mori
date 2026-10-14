import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { containsImageInput } from "../../shared/src/image-input";
import { createHeldPromptStream } from "../src/claude-agent-sdk";
import { buildEcoSdkHooks } from "../src/eco-sdk-hooks";
import { IMAGE_READ_DISABLED_REASON } from "../src/native-image-read";

test.skipIf(process.env.ECO_CLAUDE_NATIVE_SMOKE !== "1")(
  "native Claude denies screenshot Read even under bypassPermissions and sends only the tool error",
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "eco-claude-image-policy-"));
    await writeFile(
      path.join(workspace, "pelican.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
        if (!pathname.endsWith("/messages")) return Response.json({ ok: true });
        const body = (await request.json()) as Record<string, unknown>;
        requests.push(body);
        const block =
          requests.length === 1
            ? {
                type: "tool_use",
                id: "screenshot-read",
                name: "Read",
                input: { file_path: path.join(workspace, "pelican.png") },
              }
            : { type: "text", text: "IMAGE_READ_DENIED_OK" };
        const stopReason = block.type === "tool_use" ? "tool_use" : "end_turn";
        const message = {
          id: `msg_image_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [block],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        };
        if (!body.stream) return Response.json(message);
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
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
    const prompt = createHeldPromptStream("Inspect the screenshot", { uuid: crypto.randomUUID() });
    const session = query({
      prompt: prompt as never,
      options: {
        cwd: workspace,
        settingSources: [],
        tools: ["Read"],
        model: "claude-sonnet-4-20250514",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        hooks: buildEcoSdkHooks({ resolveSupportsImageInput: () => false }),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: path.join(workspace, "config"),
          ANTHROPIC_BASE_URL: server.url.origin,
          ANTHROPIC_API_KEY: "local-native-test",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });
    try {
      let succeeded = false;
      for await (const message of session) {
        if (message.type === "result") {
          succeeded = message.subtype === "success";
          prompt.close();
        }
      }
      expect(succeeded).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests.some(containsImageInput)).toBe(false);
      expect(JSON.stringify(requests[1]?.messages)).toContain(IMAGE_READ_DISABLED_REASON);
    } finally {
      prompt.close();
      session.close();
      server.stop(true);
      await rm(workspace, { recursive: true, force: true });
    }
  },
  30_000,
);
