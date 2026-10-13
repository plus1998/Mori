import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TtsMcpGateway } from "../src/main/tts-mcp-gateway";
import { TtsStore } from "../src/main/tts-store";
import type { TtsArtifact } from "../src/shared/tts";

function wav() {
  const b = Buffer.alloc(52);
  b.write("RIFF");
  b.writeUInt32LE(44, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(8, 40);
  return b;
}

test("thread-authenticated MCP calls persist audio and tool IDs; tokens, toggles and failures are isolated", async () => {
  let fail = false;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      fail
        ? Response.json({ error: { message: "Invalid voice" } }, { status: 400 })
        : Response.json({
            steps: [{ content: [{ type: "audio", mime_type: "audio/wav", data: wav().toString("base64") }] }],
          }),
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-tts-gateway-"));
  const db = new Database(":memory:");
  const store = new TtsStore(db as never, {
    isAvailable: () => true,
    encrypt: (value) => value,
    decrypt: (value) => value,
  });
  store.initialize();
  const profile = store.getSettings().profiles[0]!;
  store.saveProfile({ ...profile, baseUrl: String(provider.url).replace(/\/$/, ""), apiKey: "secret" });
  store.setEnabled(true);
  const changes: TtsArtifact[] = [];
  const gateway = new TtsMcpGateway({
    store,
    resolveWorkspacePath: () => root,
    resolveGenerationRoot: () => root,
    onArtifactChanged: (artifact) => changes.push(artifact),
  });
  try {
    const [a, b] = await Promise.all([
      gateway.resolveInjection({ threadId: "a", sessionEnabled: true }),
      gateway.resolveInjection({ threadId: "b", sessionEnabled: true }),
    ]);
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(true);
    expect(a.sdkEntry?.timeout).toBe(600000);
    const endpoint = String(a.sdkEntry?.url).replace(/\/mcp$/, "");
    const headers = a.sdkEntry?.headers as Record<string, string>;
    const call = async (callHeaders = headers) => {
      const response = await fetch(`${endpoint}/v1/tools/call`, {
        method: "POST",
        headers: { ...callHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "create_speech",
          arguments: { text: "你好", voice: "Kore", style: "温暖自然" },
        }),
      });
      return { status: response.status, body: await response.json() };
    };
    gateway.noteUpcomingTool("a", "mcp__eco_tts__create_speech", "tool-1");
    const client = new Client({ name: "tts-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(String(a.sdkEntry?.url)), { requestInit: { headers } }),
    );
    try {
      const listed = await client.listTools();
      expect(listed.tools[0]?.name).toBe("create_speech");
      expect(listed.tools[0]?.inputSchema.required).toEqual(["text", "voice", "style"]);
      const generated = await client.callTool({
        name: "create_speech",
        arguments: { text: "你好", voice: "Kore", style: "温暖自然" },
      });
      expect(generated.structuredContent).toMatchObject({
        status: "completed",
        model: "gemini-3.8-flash-tts",
      });
    } finally {
      await client.close();
    }
    expect(changes.map((artifact) => artifact.status)).toEqual(["running", "completed"]);
    expect(store.listArtifacts("a")[0]?.toolUseId).toBe("tool-1");
    expect(store.listArtifacts("b")).toEqual([]);
    expect(await fs.readFile(store.listArtifacts("a")[0]!.audio[0]!.absolutePath)).toEqual(wav());
    gateway.noteUpcomingTool("b", "create_speech", "tool-b");
    expect((await call({ ...headers, Authorization: "Bearer invalid-token" })).status).toBe(400);
    expect(store.listArtifacts("b")).toEqual([]);
    fail = true;
    const failed = await call();
    expect(failed.body.result).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", code: "provider_error", message: "Invalid voice" },
    });
    store.setEnabled(false);
    expect((await call()).status).toBe(400);
    store.setEnabled(true);
    gateway.disposeThread("a");
    expect((await call()).status).toBe(400);
    const merged = gateway.mergeIntoSdkConfig({ mcpServers: {}, allowedTools: [] }, b);
    expect(Object.keys(merged.mcpServers)).toEqual(["eco_tts"]);
  } finally {
    await gateway.close();
    provider.stop(true);
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
