import { expect, test } from "bun:test";
import { defaultSubagentAvailability } from "@eco/runtime/subagent-availability";
import { ComposerPromptCacheBaseline } from "../src/renderer/composer-prompt-cache-baseline";
import type { ThreadRuntimeConfig } from "../src/shared/thread-runtime-config";

const original: ThreadRuntimeConfig = {
  subagentEnabled: defaultSubagentAvailability(),
  sessionMode: "agent",
  bashReviewMode: "always",
};
const edited: ThreadRuntimeConfig = {
  ...original,
  mainAgentModelOverride: { providerId: "openai", modelId: "manual-model" },
};

test("changing a model does not dismiss the warning before execution starts", () => {
  const baselines = new ComposerPromptCacheBaseline();
  expect(baselines.observe("old", original, "attempt-1")).toBe(true);
  expect(baselines.observe("old", edited, "attempt-1")).toBe(false);
  expect(baselines.get("old")).toBe(original);
});

for (const entry of ["retry", "approve-plan", "scheduled-message", "other-client"]) {
  test(`${entry}: a new actual attempt accepts the configuration and clears the old drift`, () => {
    const baselines = new ComposerPromptCacheBaseline();
    baselines.observe("old", original, "attempt-1");
    expect(baselines.observe("old", edited, `attempt-${entry}`)).toBe(true);
    expect(baselines.get("old")).toBe(edited);
    expect(baselines.observe("old", original, `attempt-${entry}`)).toBe(false);
    expect(baselines.get("old")).toBe(edited);
  });
}

test("another chat's model and execution cannot change the old chat's baseline", () => {
  const baselines = new ComposerPromptCacheBaseline();
  baselines.observe("old", original, "attempt-1");
  baselines.observe("new", edited, "attempt-2");
  expect(baselines.get("old")).toBe(original);
  expect(baselines.get("new")).toBe(edited);
  expect(baselines.observe("old", edited, undefined)).toBe(false);
});

test("history hydration can seed a baseline before its actual attempt is loaded", () => {
  const baselines = new ComposerPromptCacheBaseline();
  baselines.observe("old", original, undefined);
  expect(baselines.observe("old", edited, "attempt-1")).toBe(true);
  expect(baselines.get("old")).toBe(edited);
});
