import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AsrMcpGateway } from "../src/main/asr-mcp-gateway";
import { AsrSettingsStore } from "../src/main/asr-settings-store";

for (const apiMode of ["chat_completions", "audio_transcriptions"] as const) {
  test(`ASR MCP ${apiMode}: file, auth, profile changes, errors and limits`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-asr-"));
    const db = new Database(":memory:");
    const store = new AsrSettingsStore(db as never, {
      isAvailable: () => true,
      encrypt: (v) => v,
      decrypt: (v) => v,
    });
    store.initialize();
    store.save({
      endpoint: "https://asr.example/v1",
      apiKey: "secret",
      model: "asr-model",
      apiMode,
      systemPrompt: "",
    });
    let enabled = true;
    let fail = false;
    let calls = 0;
    const gateway = new AsrMcpGateway({
      store,
      resolveWorkspacePath: () => root,
      isSessionEnabled: () => enabled,
      fetchImpl: (async (url, init) => {
        calls++;
        expect(String(url)).toEndWith(
          apiMode === "chat_completions" ? "/chat/completions" : "/audio/transcriptions",
        );
        if (apiMode === "chat_completions") {
          const body = JSON.parse(String(init?.body));
          expect(body.messages[0].content[0].input_audio.data).toBe("data:audio/mpeg;base64,YXVkaW8=");
          expect(body.model).toBe(store.getClientConfig()!.model);
        } else {
          const form = init?.body as FormData;
          const audio = form.get("file") as File;
          expect(audio.name).toBe("sample.mp3");
          expect(audio.type).toBe("audio/mpeg");
          expect(await audio.text()).toBe("audio");
          expect(form.get("model")).toBe(store.getClientConfig()!.model);
        }
        return fail
          ? Response.json({ error: { message: "provider rejected audio" } }, { status: 400 })
          : Response.json(
              apiMode === "chat_completions"
                ? { choices: [{ message: { content: "会议内容" } }] }
                : { text: "会议内容" },
            );
      }) as typeof fetch,
    });
    let client: Client | undefined;
    try {
      await fs.writeFile(path.join(root, "sample.mp3"), "audio");
      const [a, b] = await Promise.all([
        gateway.resolveInjection({ threadId: "a", sessionEnabled: true }),
        gateway.resolveInjection({ threadId: "b", sessionEnabled: true }),
      ]);
      expect(a.enabled).toBe(true);
      expect(b.sdkEntry?.headers).not.toEqual(a.sdkEntry?.headers);
      const headers = a.sdkEntry!.headers as Record<string, string>;
      client = new Client({ name: "asr-test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(String(a.sdkEntry!.url)), { requestInit: { headers } }),
      );
      expect((await client.listTools()).tools[0]?.name).toBe("transcribe_audio");
      const call = (audioPath = "sample.mp3") =>
        client!.callTool({ name: "transcribe_audio", arguments: { path: audioPath } });
      expect((await call()).structuredContent).toMatchObject({
        text: "会议内容",
        model: "asr-model",
        path: path.join(root, "sample.mp3"),
      });
      store.save({ ...store.get(), model: "changed-model" });
      expect((await call()).structuredContent).toMatchObject({ model: "changed-model" });
      fail = true;
      expect((await call()).isError).toBe(true);
      fail = false;
      const before = calls;
      expect((await call("missing.wav")).isError).toBe(true);
      expect((await call("unsupported.txt")).isError).toBe(true);
      const large = await fs.open(path.join(root, "large.wav"), "w");
      await large.truncate(8 * 1024 * 1024);
      await large.close();
      expect((await call("large.wav")).isError).toBe(true);
      enabled = false;
      expect((await call()).isError).toBe(true);
      enabled = true;
      gateway.disposeThread("a");
      expect((await call()).isError).toBe(true);
      expect(calls).toBe(before);
      expect((await gateway.resolveInjection({ threadId: "b", sessionEnabled: false })).enabled).toBe(false);
    } finally {
      await client?.close();
      await gateway.close();
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
