import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const rendererDir = new URL("../src/renderer/", import.meta.url);
const moriStyles = readFileSync(new URL("mori-assistant.css", rendererDir), "utf8");
const moriPanel = readFileSync(new URL("MoriAssistant.tsx", rendererDir), "utf8");

function ruleBody(source: string, selector: string): string {
  const pattern = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  return source.match(pattern)?.[2] ?? "";
}

function px(body: string, property: string): number {
  const match = body.match(new RegExp(`${property}:\\s*(\\d+)px`));
  return match ? Number(match[1]) : Number.NaN;
}

test("the Mori composer input keeps a roomy, non-collapsing surface", () => {
  const composer = ruleBody(moriStyles, ".mori-composer");
  const textarea = ruleBody(moriStyles, ".mori-composer textarea");

  // The card is a fixed-size flex child: the message list absorbs window shrinking, never
  // the input row (a squeezable composer is what made the field look flattened).
  expect(composer).toContain("flex: none");
  expect(composer).toContain("box-sizing: border-box");

  // Same growth ceiling as the main Composer, and a base tall enough for ~2.5 lines.
  expect(px(textarea, "min-height")).toBe(76);
  expect(px(textarea, "max-height")).toBe(200);
  expect(textarea).toContain("resize: none");
  expect(textarea).toContain("overflow-y: auto");
  expect(textarea).toContain("font-size: 15px");
  expect(textarea).toContain("line-height: 1.6");
});

test("the draft auto-grow clamp matches the stylesheet limits", () => {
  const min = moriPanel.match(/const MORI_COMPOSER_MIN_HEIGHT = (\d+);/)?.[1];
  const max = moriPanel.match(/const MORI_COMPOSER_MAX_HEIGHT = (\d+);/)?.[1];
  expect(Number(min)).toBe(px(ruleBody(moriStyles, ".mori-composer textarea"), "min-height"));
  expect(Number(max)).toBe(px(ruleBody(moriStyles, ".mori-composer textarea"), "max-height"));

  // Grow with the draft, shrink back on clear, and re-measure when wrapping changes.
  expect(moriPanel).toMatch(/field\.style\.height = "auto";/);
  expect(moriPanel).toMatch(/Math\.max\(field\.scrollHeight, MORI_COMPOSER_MIN_HEIGHT\)/);
  expect(moriPanel).toContain('window.addEventListener("resize", fit)');
});

test("the Enter-to-send hint is gone; only the busy notice remains", () => {
  expect(moriPanel).not.toContain("Enter 发送");
  expect(moriPanel).not.toContain("Shift + Enter 换行");
  // Rendered inside a `busy` guard, so nothing sits under the input at rest.
  expect(moriPanel).toMatch(/\{busy \? \(\s*<div className="mori-composer-hint" role="status">/);
  expect(moriPanel).toContain("新消息会排队发送 · 停止将取消排队消息");
});
