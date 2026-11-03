import { expect, test } from "bun:test";
import { PlanExecutionList } from "../src/renderer/PlanExecutionLinks";
import type { PlanExecutionLink } from "../src/shared/plan-execution";
import { renderLocalized } from "./i18n-test";

const link: PlanExecutionLink = {
  id: "link_1",
  planId: "plan_1",
  version: 1,
  planTitle: "Implementation plan",
  sourceThreadId: "source",
  sourceTitle: "Planning conversation",
  sourceDeleted: false,
  executionThreadId: "execution",
  executionTitle: "Implementation conversation",
  executionDeleted: false,
  status: "running",
  message: "",
  createdAt: "2026-11-03",
};

function render(threadId: string, links: PlanExecutionLink[], error?: string) {
  return renderLocalized(
    <PlanExecutionList threadId={threadId} links={links} error={error} showSummary onNavigate={() => {}} />,
    "zh-CN",
  );
}

test("the plan lists active and failed conversations together with their own statuses and errors", () => {
  const html = render("source", [
    link,
    {
      ...link,
      id: "link_2",
      executionThreadId: "failed_execution",
      executionTitle: "Failed conversation",
      status: "failed",
      message: "Selected model is at capacity.",
    },
  ]);
  expect(html).toContain("已有会话在执行中");
  expect(html).toContain("Implementation conversation");
  expect(html).toContain("Failed conversation");
  expect(html).toContain("执行失败");
  expect(html).toContain("Selected model is at capacity.");
});

test("the execution conversation offers a backlink to its source plan", () => {
  const html = render("execution", [link]);
  expect(html).toContain("来源计划 · v1");
  expect(html).toContain('title="Planning conversation"');
  expect(html).toContain("Implementation plan");
});

test("finished conversations retain their list without claiming execution is still active", () => {
  const html = render("source", [{ ...link, status: "completed" }]);
  expect(html).toContain("已创建执行会话");
  expect(html).toContain("本轮执行结束");
  expect(html).not.toContain("已有会话在执行中");
});

test("deleted targets disable navigation and load errors remain visible", () => {
  const html = render("source", [{ ...link, executionDeleted: true }], "Database unavailable");
  expect(html).toContain('disabled=""');
  expect(html).toContain("会话已删除");
  expect(html).toContain("Database unavailable");
  expect(html).not.toContain("已有会话在执行中");
});
