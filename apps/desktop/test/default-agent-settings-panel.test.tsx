import { expect, test } from "bun:test";
import { createElement } from "react";
import { DefaultAgentSettingsPanel } from "../src/renderer/DefaultAgentSettingsPanel";
import { renderLocalized } from "./i18n-test";

test("default Agent settings renders Claude Code and Codex choices", () => {
  const markup = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "claude",
      codexAvailable: true,
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("Harness");
  expect(markup).toContain("深度集成以获得更佳体验");
  expect(markup).toContain("Claude Code");
  expect(markup).toContain("Codex");
  expect(markup).toContain(
    "Claude Code 是 Agent 编程工具，能阅读代码库、编辑文件、运行命令，并接入你的开发工具。",
  );
  expect(markup).toContain("ChatGPT 中的 Codex 是 Agent 编程的指挥中心。");
  expect(markup).toContain("Pi 是一套极简的 Harness。");
  expect(markup).not.toContain("新会话默认使用");
  expect(markup).not.toContain("按会话注入");
  expect(markup).toContain('role="radiogroup"');
  expect(markup).toContain('checked="" value="claude"');
  expect(markup).toContain('src="./agent-icons/claude-code.ico"');
  expect(markup).toContain('src="./agent-icons/codex.ico"');
});

test("unavailable Codex is disabled with its explicit reason", () => {
  const markup = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "claude",
      codexAvailable: false,
      codexUnavailableReason: "未安装 Codex CLI",
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("未安装 Codex CLI");
  expect(markup).toContain("disabled");
});

test("ACP section is a core list without an enable checkbox", () => {
  const markup = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "claude",
      codexAvailable: true,
      cursorAvailable: true,
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("Harness");
  expect(markup).toContain("ACP");
  expect(markup).not.toContain("目前仅 Cursor");
  expect(markup).not.toContain("仅限 Cursor");
  expect(markup).toContain("Cursor");
  expect(markup).toContain("Cursor 是 Agent 编程助手，能理解项目代码并协助编写与修改。");
  expect(markup).toContain("sidebar-core-acp-tag");
  expect(markup).toContain('value="acp"');
  expect(markup).not.toContain("启用 Cursor");
  expect(markup).not.toContain('type="checkbox"');
  expect(markup).not.toContain("default-agent-acp-card");
  expect(markup).not.toContain("<select");
  expect(markup).not.toContain("外置");
  expect(markup).not.toMatch(/disabled="" name="default-agent" value="acp"/);
  expect(markup).not.toContain("模型设置");
});

test("selecting ACP as default shows a model settings entry, not a native select", () => {
  const markup = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "acp",
      codexAvailable: true,
      cursorAvailable: true,
      onChange: () => undefined,
      acpCursorModelId: "gpt-5.3-codex",
    }),
    "zh-CN",
  );

  expect(markup).toContain("模型设置");
  expect(markup).toContain("default-agent-model-entry");
  expect(markup).not.toContain("<select");
  expect(markup).not.toContain("default-agent-cursor-model");
});

test("model settings dialog uses the unified provider → model cascade", () => {
  const markup = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "acp",
      codexAvailable: true,
      cursorAvailable: true,
      onChange: () => undefined,
      acpCursorModelId: "gpt-5.3-codex",
      cursorModels: [{ id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", current: true, default: false }],
      initialModelSettingsOpen: true,
    }),
    "zh-CN",
  );

  expect(markup).toContain("acp-model-settings-modal");
  expect(markup).toContain("model-cascade");
  expect(markup).toContain("GPT-5.3 Codex");
  expect(markup).not.toContain("<select");
});

test("ACP row stays selectable while probe is running or last check failed", () => {
  const probing = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "claude",
      codexAvailable: true,
      cursorAvailable: false,
      cursorProbeLoading: true,
      cursorUnavailableReason: "Cursor ACP 探测失败，无法启用。",
      onChange: () => undefined,
    }),
    "zh-CN",
  );
  expect(probing).toContain("正在检测 Cursor ACP…");
  expect(probing).not.toContain("Cursor ACP 探测失败，无法启用。");
  expect(probing).not.toMatch(/disabled="" name="default-agent" value="acp"/);

  const failed = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "claude",
      codexAvailable: true,
      cursorAvailable: false,
      cursorUnavailableReason: "未找到 Cursor Agent CLI。",
      onChange: () => undefined,
    }),
    "zh-CN",
  );
  expect(failed).toContain("未找到 Cursor Agent CLI。");
  expect(failed).not.toMatch(/disabled="" name="default-agent" value="acp"/);
});
