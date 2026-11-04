import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendPlanReference, planHandoffForSend } from "../src/renderer/composer-plan-handoff";
import { composerReferences } from "../src/shared/composer-references";
import type { ThreadPendingPlan, ThreadSummary } from "../src/shared/ipc";

const plan: ThreadPendingPlan = {
  referenceId: "plan_1", version: 1, threadId: "source", userPrompt: "implement",
  analysis: "reason", plan: "# Plan", workspacePath: "/workspace", worktreePath: "/workspace",
};
const source: ThreadSummary = {
  id: "source", title: "Source plan", prompt: "implement", coreKind: "pi", status: "awaiting_plan",
  workspacePath: "/workspace", message: "", createdAt: "2026-11-03", updatedAt: "2026-11-03",
};

test("append immutable plan reference while preserving the existing draft", () => {
  const prompt = appendPlanReference("已有内容", plan, source, "计划 v1");
  expect(prompt.startsWith("已有内容\n\n")).toBe(true);
  expect(composerReferences(prompt)).toEqual([{ kind: "plan", id: "plan_1", label: "计划 v1", detail: "Source plan" }]);
  expect(composerReferences(appendPlanReference("", plan, source, "计划 v1"))).toHaveLength(1);
});

test("only the explicitly handed-off plan is linked when its reference remains", () => {
  const prompt = appendPlanReference("补充要求", plan, source, "计划 v1");
  expect(planHandoffForSend(prompt, "plan_1")).toBe("plan_1");
  expect(planHandoffForSend(prompt, undefined)).toBeUndefined();
  expect(planHandoffForSend(prompt, "plan_2")).toBeUndefined();
  expect(planHandoffForSend("已移除计划", "plan_1")).toBeUndefined();
});

test("reject missing or mismatched plan references", () => {
  expect(() => appendPlanReference("", { ...plan, referenceId: undefined }, source, "Plan")).toThrow("不匹配");
  expect(() => appendPlanReference("", plan, { ...source, id: "other" }, "Plan")).toThrow("不匹配");
});

test("new chat action saves a draft without starting a thread or resolving the plan", () => {
  const appSource = readFileSync(fileURLToPath(new URL("../src/renderer/App.tsx", import.meta.url)), "utf8");
  const start = appSource.indexOf("async function startNewChatWithPlan(plan: ThreadPendingPlan)");
  const handler = appSource.slice(start, appSource.indexOf("async function navigatePlanConversation", start));
  expect(handler).toContain("appendPlanReference(");
  expect(handler).toContain("saveComposerDraft(");
  expect(handler).toContain("switchProject(current.workspacePath)");
  expect(handler).not.toContain("startThread(");
  expect(handler).not.toContain("clearPendingPlanForThread");
  expect(handler).toContain('window.localStorage.setItem(`plan-handoff:${contextKey}`, current.referenceId)');
  expect(appSource).toContain("...(planExecutionId ? { planExecutionId } : {})");
});
