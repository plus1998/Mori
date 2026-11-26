import { expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { ComposerAcpModelTrigger } from "../src/renderer/ComposerAcpModelTrigger";
import { renderLocalized } from "./i18n-test";

const models = [
  { id: "claude-4-sonnet", displayName: "Sonnet 4", current: false, default: false },
  { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", current: true, default: false },
];

const anchorRef = createRef<HTMLDivElement>();

test("ACP composer trigger uses the model trigger, not the orchestration empty state", () => {
  const markup = renderLocalized(
    createElement(ComposerAcpModelTrigger, {
      anchorRef,
      models,
      selectedModelId: "claude-4-sonnet",
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("composer-model-trigger");
  expect(markup).toContain("composer-acp-model-trigger");
  expect(markup).toContain("Sonnet 4");
  expect(markup).not.toContain("选择编排组合");
  expect(markup).not.toContain("添加模型服务商");
  expect(markup).not.toContain("is-empty");
});

test("ACP composer trigger shows default label when no model is selected", () => {
  const markup = renderLocalized(
    createElement(ComposerAcpModelTrigger, {
      anchorRef,
      models,
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("跟随当前默认模型");
  expect(markup).toContain("自动分配");
});

test("ACP composer trigger aria-label includes the selected Cursor account", () => {
  const markup = renderLocalized(
    createElement(ComposerAcpModelTrigger, {
      anchorRef,
      models,
      selectedModelId: "claude-4-sonnet",
      accounts: [{
        id: "acc-1",
        name: "Work Cursor",
        enabled: true,
        apiKeyPreview: "key_…",
        createdAt: "",
        updatedAt: "",
      }],
      selectedAccountId: "acc-1",
      onAccountChange: () => undefined,
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("Work Cursor");
  expect(markup).toContain("composer-hover-tooltip-wrap");
});
