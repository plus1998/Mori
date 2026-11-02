import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveComposerContextPrompt } from "../src/renderer/composer-plan-handoff";

const appSource = readFileSync(fileURLToPath(new URL("../src/renderer/App.tsx", import.meta.url)), "utf8");

test("a matching plan handoff wins over the landing draft and skips persisted draft restoration", () => {
  const rawPlan = "# Approved plan\n\n1. Keep the original Markdown.\n";
  const resolution = resolveComposerContextPrompt("landing:/workspace", "older landing draft", {
    contextKey: "landing:/workspace",
    prompt: rawPlan,
    sessionMode: "agent",
  });

  expect(resolution).toEqual({
    prompt: rawPlan,
    handoffConsumed: true,
    shouldLoadPersistedDraft: false,
    sessionMode: "agent",
  });
});

test("a plan handoff is consumed only by its target context", () => {
  const handoff = { contextKey: "landing:/workspace", prompt: "# Plan", sessionMode: "agent" as const };
  const resolution = resolveComposerContextPrompt("thread:other", undefined, handoff);

  expect(resolution).toEqual({
    prompt: "",
    handoffConsumed: false,
    shouldLoadPersistedDraft: true,
  });
});

test("plan handoff reuses new-chat flow without approving or sending the original plan", () => {
  const start = appSource.indexOf("function startNewChatWithPlan(plan: ThreadPendingPlan)");
  const end = appSource.indexOf("async function addComposerImageFiles", start);
  const handler = appSource.slice(start, end);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(handler).toContain("pendingPlanComposerHandoffRef.current = {");
  expect(handler).toContain('sessionMode: "agent"');
  expect(handler).toContain("startNewChat();");
  expect(handler).not.toContain("approvePendingPlan");
  expect(handler).not.toContain("startThread");
  expect(handler).not.toContain("sendMessage");
  expect(appSource).toContain("resolveComposerContextPrompt(");
  expect(appSource).toContain("resolveComposerPlanRuntimeConfig(current, promptResolution.sessionMode)");
  expect(appSource).toContain("onStartNewSession={() => void startNewChatWithPlan(pendingPlan)}");
  expect(appSource).toContain(
    "const pendingPlan = activeThread ? pendingPlansByThread[activeThread.id] : undefined;",
  );
});
