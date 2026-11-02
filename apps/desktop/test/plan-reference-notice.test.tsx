import { expect, test } from "bun:test";
import { PlanReferenceNotice } from "../src/renderer/PlanReferenceNotice";
import { composerReferenceToken } from "../src/shared/composer-references";
import { renderLocalized } from "./i18n-test";

const plan = { kind: "plan" as const, id: "plan-1", label: "计划 v1", detail: "来源会话" };

test("ordinary plan references do not display a mode selector or execution notice", () => {
  expect(renderLocalized(
    <PlanReferenceNotice prompt={composerReferenceToken(plan)} onChange={() => {}} disabled={false} />,
    "zh-CN",
  )).toBe("");
});

test("execution handoff shows a cancellable notice even when a plain reference comes after it", () => {
  const prompt = composerReferenceToken({ ...plan, intent: "execute" }) + composerReferenceToken(plan);
  const markup = renderLocalized(
    <PlanReferenceNotice prompt={prompt} onChange={() => {}} disabled={false} />,
    "zh-CN",
  );
  expect(markup).toContain("将执行：计划 v1");
  expect(markup).toContain('aria-label="取消执行"');
  expect(markup.match(/<button/g)).toHaveLength(1);
  expect(markup).not.toContain("仅作参考");
  expect(markup).not.toContain("在此会话执行");
});
