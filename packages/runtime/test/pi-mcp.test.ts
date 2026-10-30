import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalizePiMcpFingerprint,
  fingerprintPiMcpServers,
  PI_MCP_HUB_SERVER_NAME,
  PI_MCP_HUB_TOOL_NAMES,
  toPiMcpLoadedConfig,
  toPiMcpServerConfig,
} from "../src/pi-mcp";
import { createPiMcpExtensionFactory } from "../src/pi-mcp-extension-factory";

/** Successful mapping or the mapper's explicit error, never a silent drop. */
function mappedConfig(entry: unknown): Record<string, unknown> {
  const mapped = toPiMcpServerConfig(entry);
  if (!mapped.ok) {
    throw new Error(`expected a successful mapping, got: ${mapped.error}`);
  }
  return mapped.config as unknown as Record<string, unknown>;
}

function mapError(entry: unknown): string {
  const mapped = toPiMcpServerConfig(entry);
  if (mapped.ok) {
    throw new Error("expected the mapping to fail, but it succeeded");
  }
  return mapped.error;
}

test("toPiMcpServerConfig maps stdio and strips Claude-only fields", () => {
  const mapped = mappedConfig({
    type: "stdio",
    command: "npx",
    args: ["-y", "demo-mcp"],
    env: { TOKEN: "x" },
    cwd: "/tmp/pi-work",
    description: "demo server",
    alwaysLoad: true,
    timeout: 60_000,
  });
  expect(mapped).toEqual({
    type: "stdio",
    command: "npx",
    args: ["-y", "demo-mcp"],
    env: { TOKEN: "x" },
    cwd: "/tmp/pi-work",
    description: "demo server",
    timeout: 60,
    exposure: "direct",
  });
  expect(mapped).not.toHaveProperty("alwaysLoad");
  // The adapter-era millisecond field never reaches the official extension.
  expect(mapped).not.toHaveProperty("requestTimeoutMs");
});

test("toPiMcpServerConfig omits empty args/env and optional fields", () => {
  expect(mappedConfig({ command: "server-bin" })).toEqual({
    type: "stdio",
    command: "server-bin",
    exposure: "direct",
  });
  expect(mappedConfig({ command: "server-bin", args: [], env: {}, cwd: "   " })).toEqual({
    type: "stdio",
    command: "server-bin",
    exposure: "direct",
  });
});

test("toPiMcpServerConfig prefers requestTimeoutMs over the Claude timeout, in seconds", () => {
  expect(mappedConfig({ command: "node", timeout: 60_000, requestTimeoutMs: 210_000 })).toMatchObject({
    timeout: 210,
  });
  // ms → seconds, rounded up.
  expect(mappedConfig({ command: "node", args: ["server.mjs"], timeout: 1500 })).toMatchObject({
    timeout: 2,
  });
  expect(mappedConfig({ command: "node", timeout: 60_000 })).toMatchObject({ timeout: 60 });
  // Sub-second values clamp to the 1s floor instead of rounding to 0.
  expect(mappedConfig({ command: "node", timeout: 250 })).toMatchObject({ timeout: 1 });
});

test("toPiMcpServerConfig maps http with headers, description and timeout", () => {
  expect(
    mappedConfig({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer a" },
      description: "remote",
      timeout: 120_000,
    }),
  ).toEqual({
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer a" },
    description: "remote",
    timeout: 120,
    exposure: "direct",
  });
});

test("toPiMcpServerConfig rejects SSE with an explicit error instead of dropping it", () => {
  const byType = mapError({ type: "sse", url: "https://mcp.example.com/sse" });
  expect(byType).toContain("SSE transport is not supported");
  expect(byType).toContain("Mori MCP Hub");

  const byHttpTransport = mapError({
    type: "http",
    url: "https://mcp.example.com/sse",
    httpTransport: "sse",
  });
  expect(byHttpTransport).toContain("SSE transport is not supported");
});

test("toPiMcpServerConfig errors when neither command nor url is set", () => {
  expect(mapError({ type: "stdio" })).toBe("neither command nor url is set");
  expect(mapError({ type: "http" })).toBe("neither command nor url is set");
  expect(mapError("not-an-object")).toBe("entry is not an object");
});

test("toPiMcpLoadedConfig records unmappable entries in errors and keeps them out of servers", () => {
  const config = toPiMcpLoadedConfig({
    github: { command: "uvx", args: ["mcp-github"] },
    broken: { type: "stdio" },
    remote: { type: "http", url: "https://example.com" },
    sse: { type: "sse", url: "https://example.com/sse" },
  });
  expect(config.servers.map((server) => server.name).sort()).toEqual(["github", "remote"]);
  expect(config.servers.find((server) => server.name === "broken")).toBeUndefined();
  expect(config.servers.find((server) => server.name === "sse")).toBeUndefined();
  expect(
    config.errors.some(
      (error) => error.startsWith('MCP server "broken":') && error.includes("neither command nor url"),
    ),
  ).toBe(true);
  expect(
    config.errors.some(
      (error) => error.startsWith('MCP server "sse":') && error.includes("SSE transport is not supported"),
    ),
  ).toBe(true);
});

test("every loaded server carries direct exposure and extension scope", () => {
  const config = toPiMcpLoadedConfig({
    local: { command: "node", args: ["a.mjs"] },
    remote: { url: "https://example.com/mcp" },
  });
  expect(config.servers).toHaveLength(2);
  for (const server of config.servers) {
    expect((server.config as unknown as Record<string, unknown>).exposure).toBe("direct");
    expect(server.scope).toBe("extension");
    expect(server.source).toBe("<eco:session>");
  }
  // No projectConfig: the extension has no ambient `.pi/mcp.json` to merge over
  // the Eco snapshot, and `loadConfig` replaces the file-reading default.
  expect("projectConfig" in config).toBe(false);
});

test("toPiMcpLoadedConfig keeps autoEnableCodemode disabled", () => {
  expect(toPiMcpLoadedConfig(undefined)).toEqual({ servers: [], autoEnableCodemode: false, errors: [] });
  expect(toPiMcpLoadedConfig({}).autoEnableCodemode).toBe(false);
  expect(toPiMcpLoadedConfig({ a: { command: "a" } }).autoEnableCodemode).toBe(false);
});

test("Hub server and tool names match the official extension namespace", () => {
  expect(PI_MCP_HUB_SERVER_NAME).toBe("eco_mcp");
  expect(PI_MCP_HUB_TOOL_NAMES).toEqual(["mcp__eco_mcp__search_tools", "mcp__eco_mcp__call_tool"]);
});

test("fingerprintPiMcpServers is order-independent and empty when unset", () => {
  expect(fingerprintPiMcpServers(undefined)).toBe("");
  expect(fingerprintPiMcpServers({})).toBe("");
  const a = fingerprintPiMcpServers({
    b: { command: "b" },
    a: { command: "a" },
  });
  const b = fingerprintPiMcpServers({
    a: { command: "a" },
    b: { command: "b" },
  });
  expect(a).toBe(b);
  expect(a).not.toBe(fingerprintPiMcpServers({ a: { command: "a" } }));
});

test("fingerprintPiMcpServers ignores spawn env and http headers", () => {
  const base = {
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: {
        ECO_BROWSER_CONTROL_URL: "http://127.0.0.1:1",
        ECO_BROWSER_AUTH_TOKEN: "token-a",
        ECO_BROWSER_CONTROL_SECRET: "secret-a",
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
    remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer a" } },
  };
  const rotatedSecrets = {
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: {
        ECO_BROWSER_CONTROL_URL: "http://127.0.0.1:2",
        ECO_BROWSER_AUTH_TOKEN: "token-b",
        ECO_BROWSER_CONTROL_SECRET: "secret-b",
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
    remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer b" } },
  };
  expect(fingerprintPiMcpServers(base)).toBe(fingerprintPiMcpServers(rotatedSecrets));
  // ...but a real identity change (args / url) still moves the fingerprint.
  expect(fingerprintPiMcpServers(base)).not.toBe(
    fingerprintPiMcpServers({
      ...base,
      eco_agent_browser: { command: "node", args: ["other.mjs"] },
    }),
  );
  expect(fingerprintPiMcpServers(base)).not.toBe(
    fingerprintPiMcpServers({
      ...base,
      remote: { url: "https://other.example.com/mcp" },
    }),
  );
});

test("canonicalizePiMcpFingerprint re-fingerprints a stored payload that embedded env/headers", () => {
  const live = fingerprintPiMcpServers({
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: { ECO_BROWSER_AUTH_TOKEN: "new", ELECTRON_RUN_AS_NODE: "1" },
    },
    remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer new" } },
  });
  const legacyStored = JSON.stringify([
    [
      "eco_agent_browser",
      {
        command: "node",
        args: ["b.mjs"],
        env: {
          ECO_BROWSER_CONTROL_URL: "http://127.0.0.1:1",
          ECO_BROWSER_AUTH_TOKEN: "old-token-with-secrets",
          ECO_BROWSER_CONTROL_SECRET: "old-secret",
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ],
    [
      "remote",
      {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer old-token-with-secrets" },
      },
    ],
  ]);
  expect(canonicalizePiMcpFingerprint(legacyStored)).toBe(live);
  expect(canonicalizePiMcpFingerprint("not-json")).toBe("not-json");
});

test("createPiMcpExtensionFactory returns undefined for empty config and a factory otherwise", async () => {
  expect(await createPiMcpExtensionFactory(undefined)).toBeUndefined();
  expect(await createPiMcpExtensionFactory({})).toBeUndefined();
  const factory = await createPiMcpExtensionFactory({
    docs: { url: "https://mcp.example.com/mcp" },
  });
  expect(typeof factory).toBe("function");
});

test("current MCP fingerprints preserve seconds and are idempotent", () => {
  const fingerprints = [60_000, 120_000, 300_000, 600_000].map((timeout) =>
    fingerprintPiMcpServers({ eco_mcp: { type: "http", url: "http://localhost/mcp", timeout } }),
  );
  for (const fingerprint of fingerprints) {
    expect(canonicalizePiMcpFingerprint(fingerprint)).toBe(fingerprint);
    expect(canonicalizePiMcpFingerprint(canonicalizePiMcpFingerprint(fingerprint))).toBe(fingerprint);
  }
  expect(new Set(fingerprints.map(canonicalizePiMcpFingerprint)).size).toBe(4);
});

test("adapter-era timeout fingerprints are converted exactly once", () => {
  const current = fingerprintPiMcpServers({ demo: { command: "node", timeout: 120_000 } });
  for (const entry of [
    { command: "node", lifecycle: "lazy", requestTimeoutMs: 120_000 },
    { command: "node", timeout: 120_000 },
  ]) {
    const normalized = canonicalizePiMcpFingerprint(JSON.stringify([["demo", entry]]));
    expect(normalized).toBe(current);
    expect(canonicalizePiMcpFingerprint(normalized)).toBe(current);
  }
});

test("createPiMcpExtensionFactory throws when any configured server fails to map", async () => {
  await expect(
    createPiMcpExtensionFactory({ sse: { type: "sse", url: "https://example.com/sse" } }),
  ).rejects.toThrow(/SSE transport is not supported/);
  await expect(createPiMcpExtensionFactory({ broken: { type: "stdio" } })).rejects.toThrow(
    /neither command nor url/,
  );
  // A mixed config must fail loudly instead of shipping a partial toolset.
  await expect(
    createPiMcpExtensionFactory({ ok: { command: "true" }, broken: { type: "stdio" } }),
  ).rejects.toThrow(/Invalid MCP server config/);
});

test("two createPiMcpExtensionFactory calls receive isolated config snapshots", async () => {
  const factoryA = await createPiMcpExtensionFactory({ a: { command: "server-a" } });
  const factoryB = await createPiMcpExtensionFactory({ b: { command: "server-b" } });
  expect(factoryA).toBeDefined();
  expect(factoryB).toBeDefined();
  expect(factoryA).not.toBe(factoryB);
});

test("MCP tools stay unregistered until bindExtensions emits session_start", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "eco-pi-mcp-bind-"));
  await mkdir(path.join(agentDir, "skills"), { recursive: true });
  const serverPath = path.join(import.meta.dir, "_lc-mcp-server.mjs");
  const toolName = "mcp__lc_echo__echo";

  const factory = await createPiMcpExtensionFactory(
    { lc_echo: { command: "node", args: [serverPath] } },
    { agentDir, startupWaitMs: 8_000 },
  );
  expect(factory).toBeDefined();

  const pi = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi;

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [{ name: "eco-pi-mcp", factory: factory as never }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "test",
  });
  await resourceLoader.reload();

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const sessionManager = SessionManager.inMemory(agentDir);
  const { session } = await createAgentSession({
    cwd: agentDir,
    agentDir,
    modelRuntime,
    resourceLoader: resourceLoader as never,
    // The official extension namespaces each server tool; the allowlist names
    // the real wire name, not an adapter proxy.
    tools: ["read", "bash", toolName],
    sessionManager,
    settingsManager,
  });

  const toolRegistry = () =>
    (
      session as {
        agent?: { state?: { tools?: Array<{ name: string }> } };
      }
    ).agent?.state?.tools ?? [];
  const namespacedTool = () => toolRegistry().find((tool) => tool.name === toolName);

  // No session_start yet: the extension has not connected, so the tool is absent.
  expect(namespacedTool()).toBeUndefined();

  await session.bindExtensions({ mode: "rpc" });
  const deadline = Date.now() + 8_000;
  while (!namespacedTool() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const echoTool = namespacedTool() as
    | {
        execute: (
          id: string,
          input: Record<string, unknown>,
          signal: AbortSignal,
          onUpdate: () => void,
        ) => Promise<{ content?: Array<{ text?: string }> }>;
      }
    | undefined;
  expect(echoTool).toBeDefined();
  if (!echoTool) {
    throw new Error("MCP echo tool was not registered after session_start");
  }

  const result = await echoTool.execute("call-1", { text: "hi" }, new AbortController().signal, () => {});
  expect(result.content?.[0]?.text).toContain("MCP-ECHO: hi");

  const { disposePiSdkSession } = await import("../src/pi-session-dispose");
  await disposePiSdkSession(session);
}, 30_000);
