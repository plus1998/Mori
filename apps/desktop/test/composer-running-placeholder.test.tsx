import { expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { ComposerSkillsInput } from "../src/renderer/ComposerSkillsInput";
import { renderLocalized } from "./i18n-test";

function renderPlaceholder(runningStartedAt?: string, language = "zh-CN") {
  return renderLocalized(createElement(ComposerSkillsInput, {
    value: "",
    onChange: () => undefined,
    skillsByName: new Map(),
    placeholder: "要求后续变更",
    runningStartedAt,
  }), language);
}

test("floating running placeholder uses attempt time even when opened mid-run", () => {
  const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-15T00:02:03Z"));
  try {
    expect(renderPlaceholder("2026-11-15T00:01:00Z"))
      .toContain('data-placeholder="已运行 1m 3s"');
    expect(renderPlaceholder("2026-11-15T00:02:03Z"))
      .toContain('data-placeholder="已运行 0s"');
    expect(renderPlaceholder("2026-11-15T00:02:00Z", "en"))
      .toContain('data-placeholder="Running for 3s"');
  } finally {
    now.mockRestore();
  }
});

test("normal placeholder returns when there is no active running attempt", () => {
  expect(renderPlaceholder()).toContain('data-placeholder="要求后续变更"');
});
