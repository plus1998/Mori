import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGenerationToolContext } from "../src/main/generation-tool-context";
import { ImageGenerationMcpGateway } from "../src/main/image-generation-mcp-gateway";
import { ImageGenerationStore } from "../src/main/image-generation-store";
import { TtsMcpGateway } from "../src/main/tts-mcp-gateway";
import { TtsStore } from "../src/main/tts-store";
import { generationToolScopeId } from "../src/shared/generation-tools";
import type { ImageGenerationArtifact } from "../src/shared/image-generation";
import type { TtsArtifact } from "../src/shared/tts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-direct-generation-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const codec = {
  isAvailable: () => true,
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
};
function database() {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  return db as never;
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
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

test("direct tool contexts isolate project history and resolve the actual conversation output root", async () => {
  const root = await workspace();
  const worktree = path.join(root, "worktree");
  const resolve = (id: string) =>
    id === "thr-a" ? { workspacePath: root, generationRoot: worktree } : undefined;
  const project = await resolveGenerationToolContext({ workspacePath: root }, resolve);
  expect(project).toEqual({
    threadId: generationToolScopeId({ workspacePath: root }),
    workspacePath: root,
    generationRoot: root,
  });
  expect(
    (await resolveGenerationToolContext({ workspacePath: root, threadId: "thr-a" }, resolve)).generationRoot,
  ).toBe(worktree);
  expect(generationToolScopeId({ workspacePath: root, threadId: "thr-a" })).toBe("thr-a");
  await expect(
    resolveGenerationToolContext({ workspacePath: root, threadId: "deleted" }, resolve),
  ).rejects.toThrow("不存在");
  await expect(
    resolveGenerationToolContext({ workspacePath: "/other", threadId: "thr-a" }, resolve),
  ).rejects.toThrow("不匹配");
  await expect(resolveGenerationToolContext({ workspacePath: "relative" }, resolve)).rejects.toThrow(
    "本地项目",
  );
  await expect(resolveGenerationToolContext({ workspacePath: root, threadId: 1 }, resolve)).rejects.toThrow(
    "会话无效",
  );
});

test("direct drawing saves real files and failed history without consuming an MCP claim or changing profiles", async () => {
  const root = await workspace();
  let fail = false;
  let calls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return fail
        ? Response.json({ error: { message: "Image quota exhausted" } }, { status: 429 })
        : Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  cleanups.push(() => provider.stop(true));
  const store = new ImageGenerationStore(database(), codec);
  store.initialize();
  const profile = store.getSettings().profiles[0]!;
  store.saveProfile({ ...profile, endpoint: String(provider.url).replace(/\/$/, ""), apiKey: "test-key" });
  store.setEnabled(true);
  const changes: ImageGenerationArtifact[] = [];
  const gateway = new ImageGenerationMcpGateway({
    store,
    resolveWorkspacePath: () => root,
    resolveGenerationRoot: () => root,
    onArtifactChanged: (artifact) => changes.push(artifact),
  });
  cleanups.push(() => gateway.close());
  const context = await resolveGenerationToolContext({ workspacePath: root }, () => undefined);
  gateway.noteUpcomingTool("agent-thread", "create_image", "agent-tool");
  const result = await gateway.generate(
    context,
    { prompt: "A green leaf", count: 1, size: "1024x1024", quality: "low" },
    { profileId: profile.id },
  );
  expect(result.artifact.status).toBe("completed");
  expect(result.artifact.toolUseId).toBeUndefined();
  expect(changes.map((item) => item.status)).toEqual(["running", "completed"]);
  expect(await fs.readFile(result.artifact.images[0]!.absolutePath)).toEqual(png);
  expect(store.listArtifacts("agent-thread")).toEqual([]);
  await expect(
    gateway.generate(context, { prompt: "test" }, { profileId: "changed-profile" }),
  ).rejects.toThrow("配置已改变");
  await expect(
    gateway.generate(context, { prompt: "test" }, { profileId: profile.id, profileUpdatedAt: "outdated" }),
  ).rejects.toThrow("配置已改变");
  expect(calls).toBe(1);
  fail = true;
  const failed = await gateway.generate(context, { prompt: "Retry leaf" });
  expect(failed.artifact).toMatchObject({ status: "failed", errorMessage: "Image quota exhausted" });
  expect(failed.providerStatus).toBe(429);
  expect(store.listArtifacts(context.threadId)).toHaveLength(2);
  store.setEnabled(false);
  await expect(gateway.generate(context, { prompt: "test" })).rejects.toThrow("已关闭");
  expect(calls).toBe(2);
});

test("direct speech preserves the transcript, voice and style and exposes provider failures", async () => {
  const root = await workspace();
  let fail = false;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      fail
        ? Response.json({ error: { message: "Unknown voice" } }, { status: 400 })
        : Response.json({
            steps: [{ content: [{ type: "audio", mime_type: "audio/wav", data: wav().toString("base64") }] }],
          }),
  });
  cleanups.push(() => provider.stop(true));
  const store = new TtsStore(database(), codec);
  store.initialize();
  const profile = store.getSettings().profiles[0]!;
  store.saveProfile({ ...profile, baseUrl: String(provider.url).replace(/\/$/, ""), apiKey: "test-key" });
  store.setEnabled(true);
  const changes: TtsArtifact[] = [];
  const gateway = new TtsMcpGateway({
    store,
    resolveWorkspacePath: () => root,
    resolveGenerationRoot: () => root,
    onArtifactChanged: (artifact) => changes.push(artifact),
  });
  cleanups.push(() => gateway.close());
  const context = { threadId: "thr-direct", workspacePath: root, generationRoot: root };
  const input = { text: "你好，这是原文。", voice: "Kore", style: "温暖、缓慢" };
  const result = await gateway.generate(context, input, { profileId: profile.id });
  expect(result.artifact).toMatchObject({
    status: "completed",
    text: input.text,
    parameters: { voice: input.voice, style: input.style },
  });
  expect(await fs.readFile(result.artifact.audio[0]!.absolutePath)).toEqual(wav());
  expect(changes.map((item) => item.status)).toEqual(["running", "completed"]);
  await expect(gateway.generate(context, input, { profileId: "stale" })).rejects.toThrow("配置已改变");
  fail = true;
  expect((await gateway.generate(context, input)).artifact).toMatchObject({
    status: "failed",
    errorMessage: "Unknown voice",
  });
  store.setEnabled(false);
  await expect(gateway.generate(context, input)).rejects.toThrow("已关闭");
});

test("drawing interrupted by an app restart becomes a retryable failure", async () => {
  const root = await workspace();
  const store = new ImageGenerationStore(database(), codec);
  store.initialize();
  const profile = store.getSettings().profiles[0]!;
  store.saveProfile({ ...profile, apiKey: "test-key" });
  const pending = store.createArtifact({
    threadId: "direct-project",
    prompt: "unfinished image",
    parameters: {},
    config: store.getActiveClientConfig(),
    workspacePath: root,
    generationRoot: root,
  });
  store.initialize();
  expect(store.listArtifacts("direct-project").find((item) => item.id === pending.id)).toMatchObject({
    status: "failed",
    errorCode: "interrupted",
  });
});
