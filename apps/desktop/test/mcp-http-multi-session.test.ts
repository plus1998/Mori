import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toAcpMcpServers, toPiMcpServerConfig } from "@eco/runtime";
import { BrowserMcpGateway } from "../src/main/browser-mcp-gateway";
import { ImageViewMcpGateway } from "../src/main/image-view-mcp-gateway";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const temporaryDirectories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function mcpRpc(
  url: string,
  headers: Record<string, string>,
  message: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(message),
  });
  expect(response.status).toBe(200);
  return response.json();
}

test("multi-session image-view shares one HTTP endpoint and routes by token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-mcp-multi-"));
  temporaryDirectories.push(directory);
  const pathA = path.join(directory, "a.png");
  const pathB = path.join(directory, "b.png");
  await fs.writeFile(pathA, PNG);
  await fs.writeFile(pathB, PNG);

  const calls: Array<{ threadId: string; path: string }> = [];
  const gateway = new ImageViewMcpGateway({
    analyze: async (input) => {
      calls.push({ threadId: input.threadId, path: input.path });
      return `ok:${input.threadId}`;
    },
  });
  closers.push(() => gateway.close());

  const injA = await gateway.resolveInjection("thr_a");
  const injB = await gateway.resolveInjection("thr_b");
  const injC = await gateway.resolveInjection("thr_c");

  expect(injA.sdkEntry.url).toBe(injB.sdkEntry.url);
  expect(injB.sdkEntry.url).toBe(injC.sdkEntry.url);
  expect(injA.sdkEntry.type).toBe("http");
  expect(String(injA.sdkEntry.url)).toMatch(/\/mcp$/);
  expect(injA.codexServer.transport).toBe("http");
  expect(injA.codexServer.url).toBe(injA.sdkEntry.url);

  const headersA = injA.sdkEntry.headers as Record<string, string>;
  const headersB = injB.sdkEntry.headers as Record<string, string>;
  expect(headersA.Authorization).not.toBe(headersB.Authorization);

  // Claude / PI / ACP / Codex descriptors share the same origin.
  const pi = toPiMcpServerConfig(injA.sdkEntry);
  expect(pi.ok).toBe(true);
  expect(pi.ok && pi.config).toMatchObject({
    type: "http",
    url: String(injA.sdkEntry.url),
    // Direct exposure keeps the Hub tools callable without a script sandbox.
    exposure: "direct",
  });
  const acp = toAcpMcpServers({ eco_image_view: injA.sdkEntry });
  expect(acp).toEqual([
    expect.objectContaining({
      type: "http",
      name: "eco_image_view",
      url: String(injA.sdkEntry.url),
    }),
  ]);

  gateway.noteUpcomingTool("thr_a", "view_image", "tu_a");
  gateway.noteUpcomingTool("thr_b", "view_image", "tu_b");
  gateway.noteUpcomingTool("thr_c", "view_image", "tu_c");

  const url = String(injA.sdkEntry.url);
  const results = await Promise.all([
    mcpRpc(url, headersA, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "view_image", arguments: { path: pathA } },
    }),
    mcpRpc(url, headersB, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "view_image", arguments: { path: pathB } },
    }),
    mcpRpc(url, injC.sdkEntry.headers as Record<string, string>, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "view_image", arguments: { path: pathA } },
    }),
  ]);

  const texts = results.map((entry) => {
    const body = entry as { result: { content: Array<{ text: string }> } };
    return body.result.content[0]?.text;
  });
  expect(texts.sort()).toEqual(["ok:thr_a", "ok:thr_b", "ok:thr_c"].sort());
  expect(calls.map((c) => c.threadId).sort()).toEqual(["thr_a", "thr_b", "thr_c"]);
});

test("multi-session browser prepareThread reuses one control URL for agents", async () => {
  const gateway = new BrowserMcpGateway({
    getFocusedTargetId: () => "test-target",
    ensureCdpPort: async () => {
      throw new Error("listTools must not mint CDP");
    },
    agentBrowserEnv: () => ({}),
  });
  closers.push(() => gateway.close());

  const a = await gateway.prepareThread("browser_a");
  const b = await gateway.prepareThread("browser_b");
  expect(a.sdkEntry.url).toBe(b.sdkEntry.url);
  expect(a.sdkEntry.type).toBe("http");
  expect(a.codexServer.transport).toBe("http");
  expect(a.token).not.toBe(b.token);

  const listed = await Promise.all(
    [a, b].map(async (prep) => {
      const body = (await mcpRpc(String(prep.sdkEntry.url), prep.sdkEntry.headers as Record<string, string>, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result: { tools: Array<{ name: string }> } };
      return body.result.tools.map((tool) => tool.name);
    }),
  );
  expect(listed[0]?.includes("agent_browser_open")).toBe(true);
  expect(listed[1]).toEqual(listed[0]);

  // Same MCP server description for Claude SDK shape and ACP shape.
  const claudeEntry = a.sdkEntry;
  const acpServers = toAcpMcpServers({ eco_agent_browser: claudeEntry });
  expect(acpServers[0]?.type).toBe("http");
  if (acpServers[0]?.type === "http") {
    expect(acpServers[0].url).toBe(String(claudeEntry.url));
  }
});
