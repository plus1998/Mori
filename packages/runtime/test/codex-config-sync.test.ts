import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCodexConfigToml,
  buildCodexGatewayModelAlias,
  buildCodexModelProviderSlug,
  codexConfigContainsUpstreamSecret,
  DEFAULT_DEV_ECO_GATEWAY_PORT,
  DEFAULT_ECO_GATEWAY_PORT,
  parseCodexGatewayModelAlias,
  resolveCodexHomeDir,
  resolveEcoGatewayBaseUrl,
  resolveEcoGatewayPort,
  syncCodexConfigFromEcoProviders,
} from "../src/codex-config-sync";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempEcoDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-config-"));
  tempDirs.push(dir);
  return dir;
}

test("resolveCodexHomeDir isolates CODEX_HOME under eco data dir", () => {
  const ecoDataDir = path.resolve("Users", "me", "Library", "Application Support", "Eco Coding");
  expect(resolveCodexHomeDir(ecoDataDir)).toBe(path.join(ecoDataDir, "codex"));
  expect(resolveCodexHomeDir(ecoDataDir)).not.toContain(`${path.sep}.codex`);
});

test("resolveEcoGatewayBaseUrl defaults to local eco-gateway port", () => {
  // 显式传空 env：默认端口取决于调用方的环境变量（开发模式的 VITE_DEV_SERVER_URL 会把端口
  // 换到 dev 桥接端口），断言“默认值”就不能受跑测试的终端影响。
  expect(resolveEcoGatewayBaseUrl(undefined, {})).toBe(`http://127.0.0.1:${DEFAULT_ECO_GATEWAY_PORT}/v1`);
  expect(resolveEcoGatewayPort({ ECO_GATEWAY_PORT: "19999" })).toBe(19999);
  expect(resolveEcoGatewayPort({ VITE_DEV_SERVER_URL: "http://127.0.0.1:5173/" })).toBe(
    DEFAULT_DEV_ECO_GATEWAY_PORT,
  );
  expect(resolveEcoGatewayBaseUrl(19999)).toBe("http://127.0.0.1:19999/v1");
});

test("buildCodexConfigToml maps enabled providers to eco_* model_providers", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [
      { id: "anthropic-main", name: "Anthropic Main", enabled: true },
      { id: "openrouter", name: "OpenRouter", enabled: false },
      { id: "openai", name: "OpenAI", enabled: true },
    ],
  });

  expect(toml).toContain('model_provider = "eco_anthropic-main"');
  expect(toml).toContain('model_reasoning_summary = "detailed"');
  expect(toml).toContain("[model_providers.eco_anthropic-main]");
  expect(toml).toContain('name = "Eco Gateway (eco_anthropic-main)"');
  expect(toml).toContain('base_url = "http://127.0.0.1:18765/v1"');
  expect(toml).toContain('wire_api = "responses"');
  expect(toml).toContain("stream_idle_timeout_ms = 900000");
  expect(toml).toContain("request_max_retries = 0");
  expect(toml).not.toContain("multi_agent_v2");
  expect(toml).toContain("[features]");
  expect(toml).toContain("remote_plugin = false");
  expect(toml).toContain("plugins = false");
  expect(toml).toContain("apps = false");
  expect(toml).not.toContain("view_image = false");
  expect(toml).toContain("[tools.update_plan]");
  expect(toml).toContain("enabled = true");
  expect(toml).not.toContain("multi_agent = true");
  expect(toml).not.toContain("[model_providers.eco_openai]");
  expect(toml).not.toContain("eco_openai");
  expect(toml).not.toContain('name = "OpenAI"');
  expect(toml).not.toContain("eco_openrouter");
  expect(toml).not.toMatch(/api[_-]?key/i);
  expect(toml).not.toContain("sk-ant-");
});

test("buildCodexConfigToml leaves the built-in OpenAI provider on Codex's official route", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "openai", name: "OpenAI", enabled: true }],
  });

  expect(toml).not.toContain("model_provider =");
  expect(toml).not.toContain("[model_providers.eco_openai]");
  expect(toml).not.toContain("http://127.0.0.1:18765/v1");
  expect(toml).toContain("apps = false");
  expect(toml).not.toContain("view_image = false");
});

test("buildCodexConfigToml defaults model_provider to a gateway provider when both exist", () => {
  // The trap behind the built-in OpenAI 404: with any gateway provider present the global
  // default points at eco-gateway, so anything that relies on the default instead of an
  // explicit provider is routed into a gateway that has no "openai" entry. thread/start and
  // role TOMLs must therefore pin the built-in route explicitly.
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [
      { id: "openai", name: "OpenAI", enabled: true },
      { id: "anthropic-main", name: "Anthropic", enabled: true },
    ],
  });

  expect(toml).toContain('model_provider = "eco_anthropic-main"');
  expect(toml).not.toContain("eco_openai");
});

test("buildCodexConfigToml keeps native view_image thread-scoped and leaves Eco's MCP viewer available", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    providers: [{ id: "local", name: "Local", enabled: true }],
    mcpServers: [
      {
        name: "eco_image_view",
        transport: "http",
        url: "http://127.0.0.1:12345/mcp",
        enabledTools: ["view_image"],
      },
    ],
  });

  expect(toml).toContain("[features]\nremote_plugin = false\nplugins = false");
  expect(toml).not.toContain("view_image = false");
  expect(toml).toContain("[mcp_servers.eco_image_view]");
  expect(toml).toContain('enabled_tools = ["view_image"]');
  expect(toml).not.toContain("[tools.view_image]");
});

test("syncCodexConfigFromEcoProviders does not report built-in OpenAI as a Gateway provider", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const result = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    gatewayPort: 18765,
    providers: [{ id: "openai", name: "OpenAI", enabled: true }],
  });

  expect(result.providerSlugs).toEqual([]);
  expect(result.defaultProviderSlug).toBeUndefined();
  const written = await fs.readFile(result.configPath, "utf8");
  expect(written).not.toContain("eco_openai");
  expect(Bun.TOML.parse(written).features).toMatchObject({
    apps: false,
    plugins: false,
    remote_plugin: false,
  });
});

test("buildCodexConfigToml selects the Codex remote compaction protocol only explicitly", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    providers: [
      {
        id: "native",
        name: "Vendor Native",
        enabled: true,
        apiCompat: "openai_responses",
        compactionMode: "responses-native",
      },
      {
        id: "display-openai",
        name: "OpenAI",
        enabled: true,
        apiCompat: "openai_chat_completions",
        compactionMode: "codex-local",
      },
    ],
  });

  expect(toml).toContain('[model_providers.eco_native]\nname = "OpenAI"');
  expect(toml).toContain('[model_providers.eco_display-openai]\nname = "Eco Gateway (eco_display-openai)"');
  expect(toml.match(/name = "OpenAI"/g)).toHaveLength(1);

  expect(() =>
    buildCodexConfigToml({
      ecoDataDir: "/data",
      providers: [
        {
          id: "invalid-chat",
          name: "Invalid",
          enabled: true,
          apiCompat: "openai_chat_completions",
          compactionMode: "responses-native",
        },
      ],
    }),
  ).toThrow("responses-native compaction only with apiCompat=openai_responses");
});

test("buildCodexConfigToml enables multi-agent without leaking mutable global role definitions", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    agentRoles: [
      {
        roleId: "eco_explore",
        description: "Explore",
        configFile: "./agents/eco_explore.toml",
      },
    ],
  });
  expect(toml).not.toContain("multi_agent_v2");
  expect(toml).not.toContain("suppress_unstable_features_warning");
  expect(toml).toContain("[features]");
  expect(toml).toContain("remote_plugin = false");
  expect(toml).toContain("plugins = false");
  expect(toml).toContain("multi_agent = true");
  expect(toml).toContain("hooks = true");
  expect(toml).toContain("[agents]");
  expect(toml).toContain("max_threads = 16");
  expect(toml).toContain("max_depth = 1");
  expect(toml).not.toContain("[agents.eco_explore]");
  expect(toml).not.toContain("config_file");
});

test("buildCodexConfigToml keeps process-global multi-agent support without global roles", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    enableMultiAgent: true,
  });

  expect(toml).toContain("multi_agent = true");
  expect(toml).toContain("hooks = true");
  expect(toml).toContain("[agents]");
  expect(toml).not.toContain("[agents.");
});

test("buildCodexConfigToml writes only selected MCP servers", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "x" },
      },
      {
        name: "docs",
        transport: "http",
        url: "https://example.com/mcp",
        httpHeaders: { Authorization: "Bearer token" },
        enabledTools: ["search"],
      },
    ],
  });
  expect(toml).toContain("[mcp_servers.github]");
  expect(toml).toContain('command = "npx"');
  expect(toml).toContain("[mcp_servers.github.env]");
  expect(toml).toContain('GITHUB_TOKEN = "x"');
  expect(toml).toContain("[mcp_servers.docs]");
  expect(toml).toContain('url = "https://example.com/mcp"');
  expect(toml).toContain('enabled_tools = ["search"]');
  expect(toml).not.toContain("[mcp_servers.browser]");
});

test("buildCodexConfigToml writes startup_timeout_sec for prepared MCP servers", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [
      {
        name: "mongo",
        transport: "stdio",
        command: "/usr/local/bin/npx",
        args: ["-y", "mongodb-mcp-server@latest"],
        env: { PATH: "/usr/local/bin", MDB_MCP_CONNECTION_STRING: "mongodb://localhost" },
        startupTimeoutSec: 60,
      },
    ],
  });
  expect(toml).toContain("[mcp_servers.mongo]");
  expect(toml).toContain('command = "/usr/local/bin/npx"');
  expect(toml).toContain("startup_timeout_sec = 60");
  expect(toml).toContain('PATH = "/usr/local/bin"');
});

test("buildCodexConfigToml writes tool_timeout_sec when set", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [
      {
        name: "eco_image_generation",
        transport: "stdio",
        command: "/bin/electron",
        args: ["stdio.mjs"],
        startupTimeoutSec: 60,
        toolTimeoutSec: 300,
      },
    ],
  });
  expect(toml).toContain("[mcp_servers.eco_image_generation]");
  expect(toml).toContain("startup_timeout_sec = 60");
  expect(toml).toContain("tool_timeout_sec = 300");
  expect(toml).toContain("[mcp_servers.eco_image_generation.tools.create_image]");
  expect(toml).toContain("output_token_limit = 2000");
});

test("buildCodexConfigToml writes explicit per-tool output_token_limit", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [
      {
        name: "eco_agent_browser",
        transport: "stdio",
        command: "agent-browser",
        args: ["mcp"],
        toolOutputTokenLimits: { snapshot: 4096, get_url: 256 },
      },
    ],
  });
  expect(toml).toContain("[mcp_servers.eco_agent_browser.tools.snapshot]");
  expect(toml).toContain("output_token_limit = 4096");
  expect(toml).toContain("[mcp_servers.eco_agent_browser.tools.get_url]");
  expect(toml).toContain("output_token_limit = 256");
});

test("buildCodexConfigToml omits MCP section when none selected", () => {
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [],
  });
  expect(toml).not.toContain("[mcp_servers.");
});

test("buildCodexConfigToml honors ECO_CODEX_STREAM_IDLE_TIMEOUT_MS", () => {
  const previous = process.env.ECO_CODEX_STREAM_IDLE_TIMEOUT_MS;
  process.env.ECO_CODEX_STREAM_IDLE_TIMEOUT_MS = "1200000";
  try {
    const toml = buildCodexConfigToml({
      ecoDataDir: "/data",
      gatewayBaseUrl: "http://127.0.0.1:18765/v1",
      providers: [{ id: "custom", name: "Custom", enabled: true }],
    });
    expect(toml).toContain("stream_idle_timeout_ms = 1200000");
  } finally {
    if (previous === undefined) {
      delete process.env.ECO_CODEX_STREAM_IDLE_TIMEOUT_MS;
    } else {
      process.env.ECO_CODEX_STREAM_IDLE_TIMEOUT_MS = previous;
    }
  }
});

test("syncCodexConfigFromEcoProviders writes config.toml under CODEX_HOME", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const secret = "sk-ant-test-secret-value";
  const result = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    gatewayPort: 18765,
    providers: [{ id: "anthropic-main", name: "Anthropic Main", enabled: true }],
  });

  expect(result.codexHomeDir).toBe(path.join(ecoDataDir, "codex"));
  expect(result.configPath).toBe(path.join(ecoDataDir, "codex", "config.toml"));
  expect(result.gatewayBaseUrl).toBe("http://127.0.0.1:18765/v1");
  expect(result.providerSlugs).toEqual(["eco_anthropic-main"]);
  expect(result.mcpServerNames).toEqual([]);
  expect(result.defaultProviderSlug).toBe("eco_anthropic-main");

  const written = await fs.readFile(result.configPath, "utf8");
  expect(written).toContain("[model_providers.eco_anthropic-main]");
  expect(written).not.toContain("view_image = false");
  expect(written).not.toContain("[mcp_servers.");
  expect(codexConfigContainsUpstreamSecret(written, [secret])).toBeUndefined();
});

test("syncCodexConfigFromEcoProviders writes selected MCP and clears unselected", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const withMcp = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    gatewayPort: 18765,
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: {},
      },
      {
        name: "docs",
        transport: "http",
        url: "https://example.com/mcp",
      },
    ],
  });
  expect(withMcp.mcpServerNames).toEqual(["github", "docs"]);
  let written = await fs.readFile(withMcp.configPath, "utf8");
  expect(written).toContain("[mcp_servers.github]");
  expect(written).toContain("[mcp_servers.docs]");

  const cleared = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    gatewayPort: 18765,
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    mcpServers: [{ name: "docs", transport: "http", url: "https://example.com/mcp" }],
  });
  expect(cleared.mcpServerNames).toEqual(["docs"]);
  written = await fs.readFile(cleared.configPath, "utf8");
  expect(written).toContain("[mcp_servers.docs]");
  expect(written).not.toContain("[mcp_servers.github]");
});

test("buildCodexModelProviderSlug prefixes provider id", () => {
  expect(buildCodexModelProviderSlug("anthropic-main")).toBe("eco_anthropic-main");
  expect(buildCodexModelProviderSlug("custom")).toBe("eco_custom");
});

test("buildCodexGatewayModelAlias scopes upstream model to provider", () => {
  expect(buildCodexGatewayModelAlias("packeycode-deepseek-v6i2na", "deepseek-v4-flash")).toBe(
    "eco_packeycode-deepseek-v6i2na__deepseek-v4-flash",
  );
  expect(parseCodexGatewayModelAlias("eco_packeycode-deepseek-v6i2na__deepseek-v4-flash")).toEqual({
    providerId: "packeycode-deepseek-v6i2na",
    upstreamModelId: "deepseek-v4-flash",
  });
});

test("buildCodexGatewayModelAlias uses a reversible V1 alias for apiCompat overrides", () => {
  const alias = buildCodexGatewayModelAlias(
    "mixed.__provider",
    "vendor/model.__v1",
    "openai_chat_completions",
  );
  expect(parseCodexGatewayModelAlias(alias)).toEqual({
    providerId: "mixed.__provider",
    upstreamModelId: "vendor/model.__v1",
    apiCompat: "openai_chat_completions",
  });
});

test("syncCodexConfigFromEcoProviders includes provider id custom as eco_custom", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const result = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    gatewayPort: 18765,
    providers: [{ id: "custom", name: "Custom Gateway", enabled: true }],
  });

  expect(result.providerSlugs).toEqual(["eco_custom"]);
  expect(result.defaultProviderSlug).toBe("eco_custom");

  const written = await fs.readFile(result.configPath, "utf8");
  expect(written).toContain('model_provider = "eco_custom"');
  expect(written).toContain("[model_providers.eco_custom]");
  expect(written).toContain('name = "Eco Gateway (eco_custom)"');
});

test("buildCodexConfigToml writes absolute model_catalog_json and rejects relative paths", () => {
  const catalogPath = "/Users/me/Library/Application Support/Eco Coding/codex/eco-model-catalog.json";
  const toml = buildCodexConfigToml({
    ecoDataDir: "/data",
    gatewayBaseUrl: "http://127.0.0.1:18765/v1",
    providers: [{ id: "custom", name: "Custom", enabled: true }],
    modelCatalogJsonPath: catalogPath,
  });
  expect(toml).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
  expect(toml).not.toMatch(/api[_-]?key/i);

  expect(() =>
    buildCodexConfigToml({
      ecoDataDir: "/data",
      providers: [{ id: "custom", name: "Custom", enabled: true }],
      modelCatalogJsonPath: "relative/eco-model-catalog.json",
    }),
  ).toThrow(/absolute path/i);
});

test("syncCodexConfigFromEcoProviders persists model_catalog_json without secrets", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const catalogPath = path.join(ecoDataDir, "codex", "eco-model-catalog.json");
  const secret = "sk-ant-catalog-secret";
  const result = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    gatewayPort: 18765,
    providers: [{ id: "anthropic-main", name: "Anthropic Main", enabled: true }],
    modelCatalogJsonPath: catalogPath,
  });
  expect(result.modelCatalogJsonPath).toBe(catalogPath);
  const written = await fs.readFile(result.configPath, "utf8");
  expect(written).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
  expect(codexConfigContainsUpstreamSecret(written, [secret])).toBeUndefined();
});
