import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ECO_IMAGE_VIEW_FULL_TOOL, ECO_IMAGE_VIEW_MCP_SERVER, ECO_IMAGE_VIEW_TOOL } from "@eco/runtime";
import { ImageViewMcpGateway, type ImageViewAnalyzeInput } from "../src/main/image-view-mcp-gateway";
import { McpHubGateway } from "../src/main/mcp-hub-gateway";
import { ImageViewNativeRequiredError } from "../src/main/image-view-errors";
import { runImageView, type ImageViewHost } from "../src/main/vision-analysis";
import { resolveThreadVisionAnalysisRoute } from "../src/main/vision-model-route";
import type { ProviderStore } from "../src/main/provider-store";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { VisionModelSelection } from "../src/shared/vision-model";
import { OAUTH_ACCOUNT_ID_HEADER } from "../src/main/chatgpt-gateway-account";
import {
  ECO_IMAGE_GENERATION_FULL_TOOL,
  ECO_IMAGE_GENERATION_MCP_SERVER,
} from "../src/shared/image-generation";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const temporaryDirectories: string[] = [];
const gateways: ImageViewMcpGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function createGateway(
  analyze: (input: ImageViewAnalyzeInput) => Promise<string>,
) {
  const gateway = new ImageViewMcpGateway({ analyze });
  gateways.push(gateway);
  return gateway;
}

test("global image view Codex server starts once and has a stable HTTP definition", async () => {
  const gateway = createGateway(async () => "unused");
  const first = await gateway.resolveGlobalCodexServer();
  const second = await gateway.resolveGlobalCodexServer();
  expect(first.name).toBe(ECO_IMAGE_VIEW_MCP_SERVER);
  expect(first.transport).toBe("http");
  expect(first.enabledTools).toEqual([ECO_IMAGE_VIEW_TOOL]);
  expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  expect(first.httpHeaders?.["X-Eco-Image-View-Control-Secret"]).toBeTruthy();
  expect(second).toEqual(first);
});

test("mergeIntoSdkConfig includes view_image in allowedTools", async () => {
  const gateway = createGateway(async () => "unused");
  const injection = await gateway.resolveInjection("thr_merge");
  expect(injection.sdkEntry).toMatchObject({
    type: "http",
    url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
  });
  const merged = gateway.mergeIntoSdkConfig(
    { mcpServers: { docs: { command: "echo" } }, allowedTools: ["mcp__docs__*"] },
    injection,
  );
  expect(merged.mcpServers[ECO_IMAGE_VIEW_MCP_SERVER]).toBeDefined();
  expect(merged.allowedTools).toContain(ECO_IMAGE_VIEW_FULL_TOOL);
  expect(merged.allowedTools).not.toContain(ECO_IMAGE_GENERATION_FULL_TOOL);
  expect(Object.keys(merged.mcpServers)).not.toContain(ECO_IMAGE_GENERATION_MCP_SERVER);
});

test("relative path fails without calling analyze", async () => {
  const calls: unknown[] = [];
  const gateway = createGateway(async (input) => {
    calls.push(input);
    return "should not run";
  });
  const server = await gateway.resolveGlobalCodexServer();
  const baseUrl = server.url!.replace(/\/mcp$/, "");
  gateway.noteUpcomingTool("thr_rel", ECO_IMAGE_VIEW_TOOL, "tool-rel");
  const response = await fetch(`${baseUrl}/v1/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-eco-image-view-control-secret": server.httpHeaders!["X-Eco-Image-View-Control-Secret"]!,
    },
    body: JSON.stringify({ name: ECO_IMAGE_VIEW_TOOL, arguments: { path: "shot.png" } }),
  });
  const payload = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(payload.result.isError).toBe(true);
  expect(payload.result.content[0]?.text).toContain("invalid_path");
  expect(calls).toEqual([]);
});

test("absolute PNG calls analyze once and returns text without image bytes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-image-view-mcp-"));
  temporaryDirectories.push(directory);
  const imagePath = path.join(directory, "shot.png");
  await fs.writeFile(imagePath, PNG);
  const calls: ImageViewAnalyzeInput[] = [];
  const gateway = createGateway(async (input) => {
    calls.push(input);
    return "## Overview\nred pixel";
  });
  const server = await gateway.resolveGlobalCodexServer();
  const baseUrl = server.url!.replace(/\/mcp$/, "");
  gateway.noteUpcomingTool("thr_abs", ECO_IMAGE_VIEW_TOOL, "tool-abs");
  const response = await fetch(`${baseUrl}/v1/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-eco-image-view-control-secret": server.httpHeaders!["X-Eco-Image-View-Control-Secret"]!,
    },
    body: JSON.stringify({
      name: ECO_IMAGE_VIEW_TOOL,
      arguments: { path: imagePath, question: "找报错" },
    }),
  });
  const payload = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  expect(payload.result.isError).toBeUndefined();
  expect(payload.result.content).toEqual([{ type: "text", text: "## Overview\nred pixel" }]);
  expect(JSON.stringify(payload)).not.toContain("data:image");
  expect(JSON.stringify(payload)).not.toContain(PNG.toString("base64"));
  expect(calls).toEqual([
    { threadId: "thr_abs", path: imagePath, question: "找报错", toolUseId: "tool-abs" },
  ]);
});

test("streamable HTTP /mcp initialize + tools/list + tools/call", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-image-view-mcp-http-"));
  temporaryDirectories.push(directory);
  const imagePath = path.join(directory, "shot.png");
  await fs.writeFile(imagePath, PNG);
  const gateway = createGateway(async () => "ok-report");
  const injection = await gateway.resolveInjection("thr_http");
  const url = String(injection.sdkEntry.url);
  const headers = injection.sdkEntry.headers as Record<string, string>;
  gateway.noteUpcomingTool("thr_http", ECO_IMAGE_VIEW_TOOL, "tool-http");

  const init = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  expect(init.status).toBe(200);
  expect(init.headers.get("mcp-session-id")).toBeTruthy();

  const listed = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listBody = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
  expect(listBody.result.tools.some((tool) => tool.name === ECO_IMAGE_VIEW_TOOL)).toBe(true);

  const called = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: ECO_IMAGE_VIEW_TOOL, arguments: { path: imagePath } },
    }),
  });
  const callBody = (await called.json()) as {
    result: { content: Array<{ text: string }> };
  };
  expect(callBody.result.content[0]?.text).toBe("ok-report");
});

test("one Hub registration follows live vision selection and never hides configured OAuth errors", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-live-vision-"));
  temporaryDirectories.push(directory);
  const imagePath = path.join(directory, "image.png");
  await fs.writeFile(imagePath, PNG);
  let visionSelection: VisionModelSelection | undefined;
  let failUpstream = false;
  const requests: Array<{ accountId: string | null; path: string }> = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push({ accountId: request.headers.get(OAUTH_ACCOUNT_ID_HEADER), path: new URL(request.url).pathname });
      if (failUpstream) return new Response("upstream unavailable", { status: 503 });
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "image analyzed" }] }] });
    },
  });
  const provider = {
    id: "eco-coding-chatgpt", name: "OAuth", enabled: true, authMethod: "chatgpt_subscription",
    baseUrl: upstream.url.origin, version: "v1",
  };
  const providerStore = {
    listProvidersWithSecrets: () => [provider],
    listStatelessModelCandidates: () => [],
  } as unknown as ProviderStore;
  let proxyStarts = 0;
  const host: ImageViewHost = {
    resolveRoute: () => resolveThreadVisionAnalysisRoute({
      coreKind: "codex", visionSelection, providerStore,
      resolveEcoFallback: () => ({ provider: { id: "openai" }, modelId: "login-model" }) as RuntimeRoute,
    }),
    startProxy: async () => {
      proxyStarts++;
      return { baseUrl: upstream.url.origin, apiKey: "test", aliasModelId: "vision", close: async () => {} };
    },
    registerBilling: () => {},
    unregisterBilling: () => {},
  };
  const gateway = createGateway(async input => runImageView({
    threadId: input.threadId, prompt: input.prompt!, billingAgentId: "vision-test",
    attachments: [{ mediaType: "image/png", path: input.path, data: PNG.toString("base64") }],
    signal: input.signal,
  }, host));
  const hub = new McpHubGateway();
  const signal = new AbortController().signal;
  const call = () => hub.callThreadTool("login", "eco_image_view:view_image", { path: imagePath, prompt: "describe" }, signal);
  const errorText = (result: Awaited<ReturnType<typeof call>>) => JSON.parse((result.content[0] as { text: string }).text);
  try {
    const injection = await gateway.resolveInjection("login");
    hub.registerThreadServerEntry({ name: ECO_IMAGE_VIEW_MCP_SERVER, threadId: "login", sdkEntry: injection.sdkEntry });
    await hub.prepareThread({ threadId: "login", allowedServers: [ECO_IMAGE_VIEW_MCP_SERVER] });
    const tools = await hub.searchThreadTools("login", ECO_IMAGE_VIEW_MCP_SERVER, signal);
    expect(tools.tools).toHaveLength(1);
    const missing = await call();
    expect(missing.isError).toBe(true);
    expect(errorText(missing)).toMatchObject({ code: "vision_model_unconfigured", nativeTool: "view_image", path: imagePath });
    expect(proxyStarts).toBe(0);

    visionSelection = { providerId: provider.id, modelId: "model-one", candidateModelId: "account:eco-coding-chatgpt:model-one", accountId: "account-a" };
    expect((await call()).content).toEqual([{ type: "text", text: "image analyzed" }]);
    visionSelection = { providerId: provider.id, modelId: "model-two", candidateModelId: "account:eco-coding-chatgpt:model-two", accountId: "account-b" };
    expect((await call()).isError).toBeUndefined();
    failUpstream = true;
    const failed = await call();
    expect(failed.isError).toBe(true);
    expect(errorText(failed)).toMatchObject({ code: "analyze_failed", message: expect.stringContaining("HTTP 503") });
    expect(errorText(failed).nativeTool).toBeUndefined();
    expect(errorText(failed).path).toBeUndefined();

    visionSelection = { ...visionSelection, accountId: undefined };
    const unauthorized = await call();
    expect(errorText(unauthorized)).toMatchObject({ code: "analyze_failed", message: expect.stringContaining("尚未选择账号") });
    expect(errorText(unauthorized).nativeTool).toBeUndefined();
    expect(proxyStarts).toBe(3);

    visionSelection = undefined;
    expect(errorText(await call())).toMatchObject({ code: "vision_model_unconfigured", path: imagePath });
    failUpstream = false;
    visionSelection = { providerId: provider.id, modelId: "model-one", candidateModelId: "account:eco-coding-chatgpt:model-one", accountId: "account-a" };
    expect((await call()).isError).toBeUndefined();
    expect(await hub.searchThreadTools("login", ECO_IMAGE_VIEW_MCP_SERVER, signal)).toEqual(tools);
    expect(await gateway.resolveInjection("login")).toEqual(injection);
    expect(requests).toEqual([
      { accountId: "account-a", path: "/v1/responses" },
      { accountId: "account-b", path: "/v1/responses" },
      { accountId: "account-b", path: "/v1/responses" },
      { accountId: "account-a", path: "/v1/responses" },
    ]);
  } finally {
    await hub.close();
    upstream.stop(true);
  }
});

test("native-viewer errors retain a resolved path for ref-only calls", async () => {
  const ref = `sha256:${"a".repeat(64)}`;
  const gateway = createGateway(async input => {
    expect(input.ref).toBe(ref);
    throw new ImageViewNativeRequiredError("/tmp/resolved-image.png");
  });
  const result = await gateway.viewForThread("ref-thread", { ref, prompt: "describe" });
  expect(result.isError).toBe(true);
  expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
    code: "vision_model_unconfigured", nativeTool: "view_image", path: "/tmp/resolved-image.png",
  });
});
