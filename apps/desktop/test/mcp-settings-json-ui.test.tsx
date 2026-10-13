import { expect, test } from "bun:test";
import { createElement } from "react";
import { McpJsonField, McpJsonImportDialog, McpSettingsPanel } from "../src/renderer/McpSettingsPanel";
import type { McpServerCheckResult, McpServerConfigView } from "../src/shared/ipc";
import { parseMcpJson } from "../src/shared/mcp-json";
import { renderLocalized } from "./i18n-test";

const github: McpServerConfigView = {
  id: "mcp_github_1",
  name: "github",
  transport: "stdio",
  enabled: true,
  command: "npx",
  argsJson: '["-y","@modelcontextprotocol/server-github"]',
  envJson: "{}",
  headersJson: "{}",
  allowedTools: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const checkResult: McpServerCheckResult = {
  ok: true,
  serverName: "github",
  transport: "stdio",
  checkedAt: "2026-01-01T00:00:00.000Z",
  durationMs: 12,
  message: "ok",
  capabilities: [],
};

const noopAsync = async () => undefined;

test("the connector list offers raw-JSON import next to the add button", () => {
  const markup = renderLocalized(
    createElement(McpSettingsPanel, {
      servers: [github],
      onSave: noopAsync,
      onDelete: noopAsync,
      onCheck: async () => checkResult,
    }),
    "zh-CN",
  );

  expect(markup).toContain("mcp-list-toolbar-actions");
  expect(markup).toContain("从 JSON 导入");
  expect(markup).toContain("添加服务器");
  // Both toolbar actions share one button family, so they cannot drift apart again.
  expect(markup.match(/class="mcp-add-button"/g)).toHaveLength(2);
});

test("the JSON editor points at the broken line instead of a generic failure", () => {
  const value = '{\n  "mcpServers": {\n    "fetch": {"command" "uvx"}\n  }\n}';
  const markup = renderLocalized(
    createElement(McpJsonField, {
      value,
      onChange: () => undefined,
      parse: parseMcpJson(value),
      placeholder: "{}",
      onFormat: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("mcp-json-editor has-error");
  expect(markup).toContain("JSON 语法错误");
  expect(markup).toContain("第 3 行");
  expect(markup).toContain('<span class="is-error">3</span>');
});

test("a valid blob reports the server that will actually be saved", () => {
  const value = '{"mcpServers":{"fetch":{"command":"uvx","args":["mcp-server-fetch"]}}}';
  const markup = renderLocalized(
    createElement(McpJsonField, {
      value,
      onChange: () => undefined,
      parse: parseMcpJson(value, { singleServer: true }),
      placeholder: "{}",
      onFormat: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("mcp-json-message is-ok");
  expect(markup).toContain("fetch · stdio");
  expect(markup).not.toContain("is-error");
});

test("unsupported keys are surfaced as warnings rather than dropped silently", () => {
  const value = '{"mcpServers":{"fetch":{"command":"uvx","disabledTools":["x"]}}}';
  const markup = renderLocalized(
    createElement(McpJsonField, {
      value,
      onChange: () => undefined,
      parse: parseMcpJson(value, { singleServer: true }),
      placeholder: "{}",
      onFormat: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("mcp-json-message is-warn");
  expect(markup).toContain("disabledTools 将被忽略");
});

test("import preview separates new connectors from the ones that would be updated", () => {
  const markup = renderLocalized(
    createElement(McpJsonImportDialog, {
      servers: [github],
      initialJson:
        '{"mcpServers":{"github":{"command":"npx"},"docs":{"type":"http","url":"https://example.com/mcp"}}}',
      onClose: () => undefined,
      onImport: noopAsync,
    }),
    "zh-CN",
  );

  expect(markup).toContain("从 JSON 导入连接器");
  expect(markup).toContain("已识别 2 个服务器");
  expect(markup).toContain("mcp-import-badge is-update");
  expect(markup).toContain(">将更新<");
  expect(markup).toContain(">新建<");
  expect(markup).toContain("https://example.com/mcp");
});
