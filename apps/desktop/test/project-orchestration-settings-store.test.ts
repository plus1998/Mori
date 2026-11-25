import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectOrchestrationSettingsStore } from "../src/main/project-orchestration-settings-store";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!sqliteAvailable)(
  "project orchestration settings persist by normalized workspace path",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-project-orchestration-"));
    const store = await createProjectOrchestrationSettingsStore(path.join(dir, "settings.db"));
    const workspacePath = path.join(dir, "repo", "..", "repo");
    const selection = {
      mainAgentConfigId: " user.main ",
      mainPrompt: { mode: "builtin" as const },
      subagents: { mode: "none" as const },
    };

    expect(store.get(workspacePath)).toEqual({ workspacePath: path.resolve(workspacePath) });
    expect(store.save({ workspacePath, orchestrationSelection: selection })).toEqual({
      workspacePath: path.resolve(workspacePath),
      orchestrationSelection: { ...selection, mainAgentConfigId: "user.main" },
    });
    expect(store.get(path.resolve(workspacePath)).orchestrationSelection?.mainAgentConfigId).toBe(
      "user.main",
    );
    expect(store.listSelections()).toHaveLength(1);
  },
);

test.skipIf(!sqliteAvailable)("clears deleted subagent orchestration references from projects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-project-orchestration-clear-"));
  const store = await createProjectOrchestrationSettingsStore(path.join(dir, "settings.db"));
  const matchingSelection = {
    mainAgentConfigId: "user.main",
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "orchestration" as const, orchestrationId: "user.orchestration" },
  };
  const otherSelection = {
    mainAgentConfigId: "user.main",
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "orchestration" as const, orchestrationId: "user.other" },
  };
  const matchingPath = path.join(dir, "matching");
  const otherPath = path.join(dir, "other");

  store.save({ workspacePath: matchingPath, orchestrationSelection: matchingSelection });
  store.save({ workspacePath: otherPath, orchestrationSelection: otherSelection });

  expect(store.clearSubagentOrchestrationReference(" user.orchestration ")).toBe(1);
  expect(store.get(matchingPath).orchestrationSelection).toEqual({
    ...matchingSelection,
    subagents: { mode: "none" },
  });
  expect(store.get(otherPath).orchestrationSelection).toEqual(otherSelection);
});

test.skipIf(!sqliteAvailable)("clears defaults when a selected model provider is deleted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-project-orchestration-clear-main-"));
  const store = await createProjectOrchestrationSettingsStore(path.join(dir, "settings.db"));
  const matchingSelection = {
    mainModel: { providerId: "provider-main", modelId: "model" },
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "none" as const },
  };
  const otherSelection = {
    mainModel: { providerId: "provider-other", modelId: "model" },
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "none" as const },
  };
  const matchingPath = path.join(dir, "matching");
  const otherPath = path.join(dir, "other");

  store.save({ workspacePath: matchingPath, orchestrationSelection: matchingSelection });
  store.save({ workspacePath: otherPath, orchestrationSelection: otherSelection });

  expect(store.clearMainModelProviderReference(" provider-main ")).toBe(1);
  expect(store.get(matchingPath).orchestrationSelection).toBeUndefined();
  expect(store.get(otherPath).orchestrationSelection).toEqual(otherSelection);
});

test.skipIf(!sqliteAvailable)("remembers each Harness and explicit Cursor default per project", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-project-harness-settings-"));
  const dbPath = path.join(dir, "settings.db");
  const workspacePath = path.join(dir, "repo");
  const otherPath = path.join(dir, "other");
  const store = await createProjectOrchestrationSettingsStore(dbPath);
  const selection = (providerId: string, modelId: string) => ({
    mainModel: { providerId, modelId },
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "none" as const },
  });

  store.save({ workspacePath, coreKind: "codex", orchestrationSelection: selection("openai", "codex") });
  store.save({ workspacePath, coreKind: "claude", orchestrationSelection: selection("api", "claude") });
  store.save({ workspacePath, coreKind: "acp", cursorModelId: "cursor" });
  store.save({ workspacePath, coreKind: "acp", cursorModelId: null });
  store.save({ workspacePath: otherPath, coreKind: "claude", orchestrationSelection: selection("api", "other") });

  const reopened = await createProjectOrchestrationSettingsStore(dbPath);
  expect(reopened.get(workspacePath)).toEqual({
    workspacePath,
    harnessSelections: { codex: selection("openai", "codex"), claude: selection("api", "claude") },
    cursorModelId: null,
  });
  expect(reopened.get(otherPath).harnessSelections).toEqual({ claude: selection("api", "other") });
  expect(reopened.get(otherPath).cursorModelId).toBeUndefined();
  expect(reopened.clearMainModelProviderReference("openai")).toBe(1);
  expect(reopened.get(workspacePath).harnessSelections).toEqual({ claude: selection("api", "claude") });
});
