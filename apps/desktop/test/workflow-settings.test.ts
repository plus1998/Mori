import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowSettingsStore,
  defaultWorkflowSettings,
  isWorkflowSettingsSnapshot,
  normalizeWorkflowSettingsSnapshot,
  orchestrationModeFromSnapshot,
  usesManualOrchestration,
  usesPlanMode,
  usesPlanOrchestration,
} from "../src/main/workflow-settings-store";
import { removeTempDirectory } from "./helpers/temp-directory";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const defaultWorkflowSettingsExpectation = {
  sessionMode: "agent",
  defaultCoreKind: "claude",
  showBilling: true,
  contextWindowLimitTokens: 262_144,
  maxOutputLimitTokens: "dynamic",
  followUpDeliveryMode: "steer",
  defaultBashReviewMode: "always",
} as const;

test("session mode defaults to agent", () => {
  expect(defaultWorkflowSettings()).toEqual(defaultWorkflowSettingsExpectation);
  expect(usesPlanMode(defaultWorkflowSettings())).toBe(false);
  expect(usesManualOrchestration(defaultWorkflowSettings())).toBe(false);
});

test("workflow settings show billing defaults on and accepts opt-out", () => {
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent" }).showBilling).toBe(true);
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", showBilling: false }).showBilling).toBe(
    false,
  );
  expect(isWorkflowSettingsSnapshot({ sessionMode: "agent", showBilling: false })).toBe(true);
  expect(isWorkflowSettingsSnapshot({ sessionMode: "agent", showBilling: "false" })).toBe(false);
});

test("isWorkflowSettingsSnapshot accepts sessionMode", () => {
  expect(isWorkflowSettingsSnapshot({ sessionMode: "plan" })).toBe(true);
  expect(isWorkflowSettingsSnapshot({ sessionMode: "ask" })).toBe(true);
  expect(isWorkflowSettingsSnapshot({ sessionMode: "agent", defaultCoreKind: "codex" })).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      contextWindowLimitTokens: 524_288,
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      maxOutputLimitTokens: 32_768,
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      followUpDeliveryMode: "queue",
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      contextWindowLimitTokens: 300_000,
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      contextWindowLimitTokens: 2_000_000,
    }),
  ).toBe(false);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      maxOutputLimitTokens: 30_000,
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      maxOutputLimitTokens: 262_144,
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      maxOutputLimitTokens: 2_000_000,
    }),
  ).toBe(false);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      followUpDeliveryMode: "inject",
    }),
  ).toBe(false);
  expect(isWorkflowSettingsSnapshot({ sessionMode: "agent", defaultCoreKind: "unknown" })).toBe(false);
  expect(isWorkflowSettingsSnapshot({ sessionMode: "invalid" })).toBe(false);
});

test("normalizeWorkflowSettingsSnapshot keeps valid sessionMode", () => {
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "plan" })).toEqual({
    ...defaultWorkflowSettingsExpectation,
    sessionMode: "plan",
  });
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent" })).toEqual(
    defaultWorkflowSettingsExpectation,
  );
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "ask" })).toEqual({
    ...defaultWorkflowSettingsExpectation,
    sessionMode: "ask",
  });
  expect(normalizeWorkflowSettingsSnapshot({})).toEqual(defaultWorkflowSettingsExpectation);
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", followUpDeliveryMode: "queue" })).toEqual({
    ...defaultWorkflowSettingsExpectation,
    followUpDeliveryMode: "queue",
  });
});

test("orchestrationModeFromSnapshot maps session mode to runtime mode", () => {
  expect(orchestrationModeFromSnapshot({ sessionMode: "plan" })).toBe("manual");
  expect(orchestrationModeFromSnapshot({ sessionMode: "agent" })).toBe("autonomous");
  expect(orchestrationModeFromSnapshot({ sessionMode: "ask" })).toBe("autonomous");
});

test("usesPlanOrchestration is alias for plan session mode", () => {
  expect(usesPlanOrchestration({ sessionMode: "plan" })).toBe(true);
  expect(usesPlanOrchestration({ sessionMode: "agent" })).toBe(false);
});

test("normalizeWorkflowSettingsSnapshot preserves composer MCP defaults", () => {
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      mcpServersEnabled: { mongo: true, browser: false },
    }),
  ).toEqual({
    ...defaultWorkflowSettingsExpectation,
    mcpServersEnabled: { mongo: true, browser: false },
  });
});

test("normalizeWorkflowSettingsSnapshot preserves default orchestration selection", () => {
  const selection = {
    mainAgentConfigId: "user.main",
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "none" as const },
  };
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultOrchestrationSelection: selection,
    }),
  ).toEqual({
    ...defaultWorkflowSettingsExpectation,
    defaultOrchestrationSelection: selection,
  });
});

test("normalizeWorkflowSettingsSnapshot preserves a valid default Core", () => {
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", defaultCoreKind: "codex" })).toEqual({
    ...defaultWorkflowSettingsExpectation,
    defaultCoreKind: "codex",
  });
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", defaultCoreKind: "unknown" })).toEqual(
    defaultWorkflowSettingsExpectation,
  );
});

test("normalizeWorkflowSettingsSnapshot preserves supported context and max output limits", () => {
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      contextWindowLimitTokens: 1_048_576,
    }).contextWindowLimitTokens,
  ).toBe(1_048_576);
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      contextWindowLimitTokens: 300_000,
    }).contextWindowLimitTokens,
  ).toBe(300_032);
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      maxOutputLimitTokens: 65_536,
    }).maxOutputLimitTokens,
  ).toBe(65_536);
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      maxOutputLimitTokens: 2_000_000,
    }).maxOutputLimitTokens,
  ).toBe(262_144);
});

test.skipIf(!sqliteAvailable)("workflow settings store persists composer MCP selections", async () => {
  const dbPath = path.join(os.tmpdir(), `eco-workflow-settings-${Date.now()}.sqlite`);
  const store = await createWorkflowSettingsStore(dbPath);
  const saved = store.save({
    sessionMode: "plan",
    defaultCoreKind: "codex",
    contextWindowLimitTokens: 524_288,
    maxOutputLimitTokens: 65_536,
    defaultOrchestrationSelection: {
      mainAgentConfigId: "user.main",
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    },
    mcpServersEnabled: { mongo: true, browser: false },
  });
  expect(saved).toEqual({
    sessionMode: "plan",
    defaultCoreKind: "codex",
    showBilling: true,
    contextWindowLimitTokens: 524_288,
    maxOutputLimitTokens: 65_536,
    followUpDeliveryMode: "steer",
    defaultBashReviewMode: "always",
    defaultOrchestrationSelection: {
      mainAgentConfigId: "user.main",
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    },
    mcpServersEnabled: { mongo: true, browser: false },
  });
  expect(store.get()).toEqual(saved);
  await removeTempDirectory(dbPath);
});

test.skipIf(!sqliteAvailable)("workflow settings store persists follow-up delivery mode", async () => {
  const dbPath = path.join(os.tmpdir(), `eco-workflow-follow-up-${Date.now()}.sqlite`);
  const store = await createWorkflowSettingsStore(dbPath);
  const saved = store.save({
    sessionMode: "agent",
    defaultCoreKind: "claude",
    contextWindowLimitTokens: 262_144,
    maxOutputLimitTokens: 32_768,
    followUpDeliveryMode: "queue",
  });
  expect(saved.followUpDeliveryMode).toBe("queue");
  expect(store.get().followUpDeliveryMode).toBe("queue");
  await removeTempDirectory(dbPath);
});
