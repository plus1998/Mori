import { expect, test } from "bun:test";
import { usesChatGptLogin, usesCodexNativeTitle } from "../src/shared/codex-native-capabilities";
import type { ThreadRuntimeConfig } from "../src/shared/thread-runtime-config";
import { defaultSubagentAvailability } from "@eco/runtime";
import { buildEcoComputerUsePromptAppend } from "../src/shared/computer-use";
import { forwardCodexSessionTitle } from "../src/main/codex-session-title";

function loginThread(coreKind = "codex", providerId = "openai") {
  const runtimeConfig: ThreadRuntimeConfig = {
    orchestrationSelection: {
      mainModel: { providerId, modelId: "gpt-test", accountId: "chosen-login-account" },
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    },
    subagentEnabled: defaultSubagentAvailability(),
    sessionMode: "agent",
    bashReviewMode: "always",
  };
  return { coreKind, runtimeConfig };
}

test("only native Login on the Codex harness uses native title synchronization", () => {
  expect(usesCodexNativeTitle(loginThread())).toBe(true);
  expect(usesChatGptLogin(loginThread())).toBe(true);
  for (const thread of [loginThread("claude"), loginThread("pi"), loginThread("acp"),
    loginThread("codex", "eco-coding-chatgpt"), loginThread("codex", "custom")]) {
    expect(usesCodexNativeTitle(thread)).toBe(false);
    expect(usesChatGptLogin(thread)).toBe(false);
  }
});

test("vision configuration does not change Login identity or native title selection", () => {
  const thread = loginThread();
  const selection = { providerId: "custom", modelId: "vision", candidateModelId: "candidate" };
  thread.runtimeConfig.visionModel = selection;
  expect(usesChatGptLogin(thread)).toBe(true);
  expect(usesCodexNativeTitle(thread)).toBe(true);
  delete thread.runtimeConfig.visionModel;
  thread.runtimeConfig.auxiliaryModel = selection;
  expect(usesChatGptLogin(thread)).toBe(true);
  expect(usesCodexNativeTitle(thread)).toBe(false);
});

test("computer use instructions keep the Mori image viewer entry", () => {
  expect(buildEcoComputerUsePromptAppend()).toContain("eco_image_view:view_image");
});

test("Codex title notifications only rename the mapped root, never children or empty names", () => {
  const updates: unknown[] = [];
  const map = { getEcoThreadId: (id: string) => id === "root" ? "mori-thread" : undefined };
  const onName = (id: string, name: string) => updates.push({ id, name });
  for (const payload of [null, {}, { threadId: "root", threadName: " " },
    { threadId: "child", threadName: "Child title" }, { threadId: "unknown", threadName: "Other title" }]) {
    forwardCodexSessionTitle(map, payload, onName);
  }
  expect(updates).toEqual([]);
  forwardCodexSessionTitle(map, { threadId: "root", threadName: "Codex title" }, onName);
  expect(updates).toEqual([{ id: "mori-thread", name: "Codex title" }]);
});
