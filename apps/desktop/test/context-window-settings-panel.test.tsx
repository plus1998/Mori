import { expect, test } from "bun:test";
import { createElement } from "react";
import { ContextWindowSettingsPanel } from "../src/renderer/ContextWindowSettingsPanel";
import { renderLocalized } from "./i18n-test";

test("context settings displays dynamic mode without a fixed output slider", () => {
  const markup = renderLocalized(
    createElement(ContextWindowSettingsPanel, {
      contextWindowLimitTokens: 262_144,
      maxOutputLimitTokens: "dynamic",
      onChangeContextWindow: async () => {},
      onChangeMaxOutput: async () => {},
    }),
    "zh-CN",
  );
  expect(markup).toContain("动态计算");
  expect(markup).toContain("固定上限");
  expect(markup.match(/role="slider"/g)).toHaveLength(1);
});

test("context settings retains the fixed output slider", () => {
  const markup = renderLocalized(
    createElement(ContextWindowSettingsPanel, {
      contextWindowLimitTokens: 262_144,
      maxOutputLimitTokens: 65_536,
      onChangeContextWindow: async () => {},
      onChangeMaxOutput: async () => {},
    }),
    "zh-CN",
  );
  expect(markup).toContain("65,536 tokens");
  expect(markup.match(/role="slider"/g)).toHaveLength(2);
});
