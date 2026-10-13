import { expect, test } from "bun:test";
import { parseMcpJson, prettifyMcpJson, serializeMcpServersJson } from "../src/shared/mcp-json";

test("parses the doc-style mcpServers blob users copy from vendor docs", () => {
  const result = parseMcpJson(`{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "secret" }
    }
  }
}`);

  expect(result.ok).toBe(true);
  expect(result.servers).toHaveLength(1);
  expect(result.servers[0]).toMatchObject({
    name: "github",
    transport: "stdio",
    enabled: true,
    command: "npx",
  });
  expect(result.servers[0]?.argsJson).toBe('["-y","@modelcontextprotocol/server-github"]');
  expect(result.servers[0]?.envJson).toBe('{"GITHUB_TOKEN":"secret"}');
});

test("recognises http and sse entries, including streamable-http aliases and httpHeaders", () => {
  const result = parseMcpJson(`{
  "mcpServers": {
    "docs": { "type": "streamable-http", "url": "https://example.com/mcp", "httpHeaders": { "Authorization": "Bearer x" } },
    "legacy": { "type": "sse", "url": "https://example.com/sse" }
  }
}`);

  expect(result.errors).toEqual([]);
  expect(result.servers.map((server) => [server.name, server.transport])).toEqual([
    ["docs", "http"],
    ["legacy", "sse"],
  ]);
  expect(result.servers[0]?.headersJson).toBe('{"Authorization":"Bearer x"}');
});

test("accepts a bare entry when the editor already knows the server name", () => {
  const result = parseMcpJson('{"command":"uvx","args":["mcp-server-fetch"]}', {
    fallbackName: "fetch",
    singleServer: true,
  });

  expect(result.ok).toBe(true);
  expect(result.servers[0]).toMatchObject({ name: "fetch", transport: "stdio", command: "uvx" });
});

test("tolerates comments, trailing commas and smart quotes from pasted docs", () => {
  const result = parseMcpJson(`{
  // fetch the web
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"], /* keep it simple */
    },
  }
}`);

  expect(result.errors).toEqual([]);
  expect(result.servers[0]).toMatchObject({ name: "fetch", command: "uvx" });

  const smart = parseMcpJson(
    "{\u201CmcpServers\u201D: {\u201Cfetch\u201D: {\u201Ccommand\u201D: \u201Cuvx\u201D}}}",
    {
      singleServer: true,
    },
  );
  expect(smart.servers[0]).toMatchObject({ name: "fetch", command: "uvx" });

  const doubled = parseMcpJson('{"mcpServers":{"fetch":{"command":"uvx", /*x*/,}}}', {
    singleServer: true,
  });
  expect(doubled.errors).toEqual([]);
  expect(doubled.servers[0]).toMatchObject({ name: "fetch", command: "uvx" });
});

test("reports syntax errors with the line and column the user is looking at", () => {
  const result = parseMcpJson('{\n  "mcpServers": {\n    "fetch": {"command" "uvx"}\n  }\n}\n');

  expect(result.ok).toBe(false);
  expect(result.errors[0]?.code).toBe("syntax");
  expect(result.errors[0]?.line).toBe(3);
  expect(result.errors[0]?.column).toBeGreaterThan(0);

  // Comments are blanked, not deleted, so the reported line still matches the editor.
  const commented = parseMcpJson('{\n  // note\n  "mcpServers": {\n    "fetch": {"command" "uvx"}\n  }\n}\n');
  expect(commented.errors[0]?.line).toBe(4);
});

test("flags unknown fields and structural problems instead of silently dropping config", () => {
  const unknown = parseMcpJson('{"mcpServers":{"fetch":{"command":"uvx","disabledTools":["x"]}}}', {
    singleServer: true,
  });
  expect(unknown.ok).toBe(true);
  expect(unknown.warnings.map((issue) => [issue.code, issue.params?.field])).toEqual([
    ["unknownField", "disabledTools"],
  ]);

  const noCommand = parseMcpJson('{"mcpServers":{"fetch":{"args":["x"]}}}');
  expect(noCommand.errors[0]?.code).toBe("missingCommand");
  expect(noCommand.errors[0]?.serverName).toBe("fetch");

  const badArgs = parseMcpJson('{"mcpServers":{"fetch":{"command":"uvx","args":{"a":1}}}}');
  expect(badArgs.errors[0]?.code).toBe("invalidArgs");

  const badName = parseMcpJson('{"mcpServers":{"GitHub MCP":{"command":"uvx"}}}');
  expect(badName.errors[0]?.code).toBe("nameInvalid");
});

test("keeps the single-server editor honest about multi-server blobs", () => {
  const result = parseMcpJson('{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}', {
    singleServer: true,
  });
  expect(result.errors[0]?.code).toBe("tooMany");
  expect(result.errors[0]?.params?.count).toBe("2");
});

test("serializes back into the doc shape and round-trips through the parser", () => {
  const json = serializeMcpServersJson([
    {
      id: "mcp_github_1",
      name: "github",
      transport: "stdio",
      enabled: true,
      command: "npx",
      argsJson: '["-y","server-github"]',
      envJson: '{"TOKEN":"x"}',
      headersJson: "{}",
      allowedTools: "mcp__github__list_issues",
    },
    {
      id: "mcp_docs_2",
      name: "docs",
      transport: "http",
      enabled: false,
      url: "https://example.com/mcp",
      argsJson: "[]",
      envJson: "{}",
      headersJson: '{"Authorization":"Bearer x"}',
      allowedTools: "",
    },
  ]);

  expect(json).toContain('"mcpServers"');
  expect(json).toContain('"allowedTools": ["mcp__github__list_issues"]');
  expect(json).toContain('"enabled": false');

  const parsed = parseMcpJson(json);
  expect(parsed.ok).toBe(true);
  expect(parsed.servers[0]).toMatchObject({
    name: "github",
    transport: "stdio",
    command: "npx",
    argsJson: '["-y","server-github"]',
    envJson: '{"TOKEN":"x"}',
    allowedTools: "mcp__github__list_issues",
  });
  expect(parsed.servers[1]).toMatchObject({
    name: "docs",
    transport: "http",
    enabled: false,
    url: "https://example.com/mcp",
    headersJson: '{"Authorization":"Bearer x"}',
  });
});

test("prettify re-indents pasted JSON without inventing app-specific keys", () => {
  const pretty = prettifyMcpJson('{"command":"uvx","args":["mcp-server-fetch"],}');
  expect(pretty).toBe('{\n  "command": "uvx",\n  "args": ["mcp-server-fetch"]\n}\n');
  expect(prettifyMcpJson('{"command":')).toBeUndefined();
});
