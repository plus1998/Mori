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
  // Dynamic mode keeps the max-output readout neutral; only the context cap is accent-styled.
  expect(markup.match(/class="token-limits-readout"/g)).toHaveLength(1);
  expect(markup.match(/class="token-limits-readout is-accent"/g)).toHaveLength(1);
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
  expect(markup).toContain('class="token-limits-readout is-accent"');
});

test("context settings explains each limit in plain language, without formulas", () => {
  const props = {
    contextWindowLimitTokens: 262_144,
    maxOutputLimitTokens: 65_536 as const,
    onChangeContextWindow: async () => {},
    onChangeMaxOutput: async () => {},
  };
  const chinese = renderLocalized(createElement(ContextWindowSettingsPanel, props), "zh-CN");
  const english = renderLocalized(createElement(ContextWindowSettingsPanel, props), "en-US");
  for (const markup of [chinese, english]) {
    expect(markup).not.toContain("<code");
    expect(markup).not.toContain("min(");
    expect(markup).not.toContain("`");
  }
  expect(chinese).toContain("模型自身窗口更小时");
  expect(english).toContain("keep their own");
});
