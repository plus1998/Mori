import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowSettingsStore,
  isWorkflowSettingsSnapshot,
  normalizeWorkflowSettingsSnapshot,
  resolveAcpCursorApiKeyForSave,
} from "../src/main/workflow-settings-store";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test("workflow settings preserve and normalize defaultBashReviewMode", () => {
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultBashReviewMode: "auto",
    }).defaultBashReviewMode,
  ).toBe("auto");
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultBashReviewMode: "allow_all",
    }).defaultBashReviewMode,
  ).toBe("allow_all");
  expect(
    normalizeWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultBashReviewMode: "nope",
    }).defaultBashReviewMode,
  ).toBe("always");
  expect(normalizeWorkflowSettingsSnapshot({ sessionMode: "agent" }).defaultBashReviewMode).toBe("always");
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultBashReviewMode: "allow_all",
    }),
  ).toBe(true);
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultBashReviewMode: "invalid",
    }),
  ).toBe(false);
});

test("workflow settings preserve a valid default auxiliary model", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({
    sessionMode: "agent",
    defaultCoreKind: "codex",
    defaultAuxiliaryModel: {
      providerId: " provider ",
      modelId: " model ",
      candidateModelId: " candidate ",
    },
  });

  expect(snapshot.defaultAuxiliaryModel).toEqual({
    providerId: "provider",
    modelId: "model",
    candidateModelId: "candidate",
  });
  expect(isWorkflowSettingsSnapshot(snapshot)).toBe(true);
});

test("workflow settings preserve ACP Cursor model id without treating it as an Eco provider", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({
    sessionMode: "agent",
    defaultCoreKind: "acp",
    defaultAcpAgentId: "cursor",
    acpCursorModelId: "  gpt-5.3-codex  ",
  });

  expect(snapshot.acpCursorModelId).toBe("gpt-5.3-codex");
  expect(isWorkflowSettingsSnapshot(snapshot)).toBe(true);
  expect(
    normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", acpCursorModelId: "   " }).acpCursorModelId,
  ).toBeUndefined();
});

test("normalize migrates legacy cursorCoreEnabled / cursorModelId to ACP fields", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({
    sessionMode: "agent",
    defaultCoreKind: "cursor",
    cursorCoreEnabled: true,
    cursorModelId: "  gpt-5.3-codex  ",
  });
  expect(snapshot.acpAgentsEnabled).toEqual({ cursor: true });
  expect(snapshot.acpCursorModelId).toBe("gpt-5.3-codex");
  expect(snapshot.defaultCoreKind).toBe("acp");
  expect(snapshot.defaultAcpAgentId).toBe("cursor");
  expect("cursorCoreEnabled" in snapshot).toBe(false);
  expect("cursorModelId" in snapshot).toBe(false);
});

test("workflow settings preserve a valid default vision model", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({
    sessionMode: "agent",
    defaultCoreKind: "codex",
    defaultVisionModel: {
      providerId: " provider ",
      modelId: " vision-model ",
      candidateModelId: " candidate-vision ",
    },
  });

  expect(snapshot.defaultVisionModel).toEqual({
    providerId: "provider",
    modelId: "vision-model",
    candidateModelId: "candidate-vision",
  });
  expect(isWorkflowSettingsSnapshot(snapshot)).toBe(true);
});

test("workflow settings reject an incomplete auxiliary model", () => {
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultAuxiliaryModel: { providerId: "provider", modelId: "model" },
    }),
  ).toBe(false);
});

test("workflow settings reject an incomplete vision model", () => {
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      defaultVisionModel: { providerId: "provider", modelId: "model" },
    }),
  ).toBe(false);
});

test.skipIf(!sqliteAvailable)("persists defaultBashReviewMode round-trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-settings-bash-"));
  const store = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
  store.save({
    sessionMode: "agent",
    defaultCoreKind: "claude",
    defaultBashReviewMode: "allow_all",
  });
  expect(store.get().defaultBashReviewMode).toBe("allow_all");

  const reopened = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
  expect(reopened.get().defaultBashReviewMode).toBe("allow_all");
});

test.skipIf(!sqliteAvailable)("clears deleted subagent orchestration from the global default", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-settings-clear-"));
  const store = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
  store.save({
    sessionMode: "agent",
    defaultCoreKind: "codex",
    defaultOrchestrationSelection: {
      mainAgentConfigId: "user.main",
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "orchestration", orchestrationId: "user.orchestration" },
    },
  });

  expect(store.clearDefaultSubagentOrchestrationReference("user.orchestration")).toBe(true);
  expect(store.get().defaultOrchestrationSelection).toEqual({
    mainAgentConfigId: "user.main",
    mainPrompt: { mode: "builtin" },
    subagents: { mode: "none" },
  });
});

test.skipIf(!sqliteAvailable)(
  "clearDefaultMainAgentConfigReference drops the global default selection",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-settings-clear-main-"));
    const store = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
    store.save({
      sessionMode: "agent",
      defaultCoreKind: "codex",
      defaultOrchestrationSelection: {
        mainAgentConfigId: "user.main",
        mainPrompt: { mode: "builtin" },
        subagents: { mode: "none" },
      },
    });

    expect(store.clearDefaultMainAgentConfigReference("user.main")).toBe(true);
    expect(store.get().defaultOrchestrationSelection).toBeUndefined();
  },
);

test("workflow settings default acpAgentsEnabled.cursor is off", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({ sessionMode: "agent" });
  expect(snapshot.acpAgentsEnabled).toBeUndefined();
  expect(snapshot.acpAgentsEnabled?.cursor === true).toBe(false);
});

test("workflow settings preserve acpAgentsEnabled.cursor true", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({
    sessionMode: "agent",
    acpAgentsEnabled: { cursor: true },
  });
  expect(snapshot.acpAgentsEnabled).toEqual({ cursor: true });
  expect(isWorkflowSettingsSnapshot(snapshot)).toBe(true);
});

test("workflow settings preserve ACP Cursor API key (trimmed, bounded) and clear on blank", () => {
  const snapshot = normalizeWorkflowSettingsSnapshot({
    sessionMode: "agent",
    defaultCoreKind: "acp",
    acpCursorApiKey: "  ck-test-123  ",
  });
  expect(snapshot.acpCursorApiKey).toBe("ck-test-123");
  expect(isWorkflowSettingsSnapshot(snapshot)).toBe(true);
  expect(
    normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", acpCursorApiKey: "   " }).acpCursorApiKey,
  ).toBeUndefined();
  expect(
    normalizeWorkflowSettingsSnapshot({ sessionMode: "agent", acpCursorApiKey: "x".repeat(513) })
      .acpCursorApiKey,
  ).toBeUndefined();
});

test("workflow-settings:save partial payload preserves stored Cursor API key; explicit blank clears", () => {
  const previousKey = "ck-abc";
  // Omitted (the mobile `workflow-settings:save` payload shape) → keep existing.
  expect(resolveAcpCursorApiKeyForSave({ sessionMode: "agent" }, previousKey)).toBe("ck-abc");
  // null / undefined field → keep existing.
  expect(resolveAcpCursorApiKeyForSave({ acpCursorApiKey: null }, previousKey)).toBe("ck-abc");
  // Explicit value → set (trimmed).
  expect(resolveAcpCursorApiKeyForSave({ acpCursorApiKey: "  ck-new " }, undefined)).toBe("ck-new");
  // Explicit blank string → clear (the desktop "clear key" control sends "").
  expect(resolveAcpCursorApiKeyForSave({ acpCursorApiKey: "" }, previousKey)).toBeUndefined();
  // Nothing stored and omitted → stays undefined.
  expect(resolveAcpCursorApiKeyForSave({ sessionMode: "agent" }, undefined)).toBeUndefined();
});

test.skipIf(!sqliteAvailable)("persists ACP Cursor API key round-trip and clears on blank", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-acp-apikey-"));
  const store = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
  const withKey = store.save({
    sessionMode: "agent",
    defaultCoreKind: "acp",
    acpCursorApiKey: "ck-abc",
  });
  expect(withKey.acpCursorApiKey).toBe("ck-abc");
  const cleared = store.save({ ...withKey, acpCursorApiKey: "" });
  expect(cleared.acpCursorApiKey).toBeUndefined();
});

test.skipIf(!sqliteAvailable)(
  "mobile-style partial workflow save preserves stored Cursor API key (regression)",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-mobile-partial-"));
    const store = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
    store.save({ sessionMode: "agent", defaultCoreKind: "acp", acpCursorApiKey: "ck-pc" });

    // Mobile partial payload: has NO acpCursorApiKey field (the phone never carries it),
    // e.g. persistAuxiliaryModelWorkflowDefault / _saveDefaultCoreKind.
    const mobilePayload = { sessionMode: "agent", defaultCoreKind: "claude", showBilling: true };
    const normalized = normalizeWorkflowSettingsSnapshot(mobilePayload);

    // Without the fix, saving the key-less snapshot wipes the stored key.
    store.save({ ...normalized });
    expect(store.get().acpCursorApiKey).toBeUndefined();

    // Re-seed the key, then apply the handler's resolution (preserve on omission).
    store.save({ sessionMode: "agent", defaultCoreKind: "acp", acpCursorApiKey: "ck-pc" });
    const previous = store.get();
    const gated: typeof normalized = { ...normalized };
    const resolvedKey = resolveAcpCursorApiKeyForSave(mobilePayload, previous.acpCursorApiKey);
    if (resolvedKey === undefined) {
      delete gated.acpCursorApiKey;
    } else {
      gated.acpCursorApiKey = resolvedKey;
    }
    store.save(gated);
    expect(store.get().acpCursorApiKey).toBe("ck-pc");
  },
);

test("workflow settings reject non-object acpAgentsEnabled", () => {
  expect(
    isWorkflowSettingsSnapshot({
      sessionMode: "agent",
      acpAgentsEnabled: "yes",
    }),
  ).toBe(false);
});

test.skipIf(!sqliteAvailable)("persists acpAgentsEnabled round-trip and drops legacy keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-acp-enabled-"));
  const store = await createWorkflowSettingsStore(path.join(dir, "settings.db"));
  store.save({
    sessionMode: "agent",
    defaultCoreKind: "claude",
    acpAgentsEnabled: { cursor: true },
    acpCursorModelId: "gpt-5.3-codex",
    defaultAcpAgentId: "cursor",
  });
  expect(store.get().acpAgentsEnabled).toEqual({ cursor: true });
  expect(store.get().acpCursorModelId).toBe("gpt-5.3-codex");
  expect(store.get().defaultAcpAgentId).toBe("cursor");
  store.save({ sessionMode: "agent", defaultCoreKind: "claude" });
  expect(store.get().acpAgentsEnabled?.cursor === true).toBe(false);
  expect(store.get().acpCursorModelId).toBeUndefined();
});

test.skipIf(!sqliteAvailable)("get migrates legacy cursor_core_enabled / cursor_model_id once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workflow-acp-migrate-"));
  const dbPath = path.join(dir, "settings.db");
  const store = await createWorkflowSettingsStore(dbPath);
  // Seed legacy keys via raw SQL through a second handle after initialize.
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run("cursor_core_enabled", JSON.stringify(true), now);
  db.prepare(
    `INSERT INTO workflow_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run("cursor_model_id", JSON.stringify("legacy-model"), now);
  db.prepare(
    `INSERT INTO workflow_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run("default_core_kind", JSON.stringify("cursor"), now);
  db.close();

  const migrated = await createWorkflowSettingsStore(dbPath);
  const snapshot = migrated.get();
  expect(snapshot.acpAgentsEnabled).toEqual({ cursor: true });
  expect(snapshot.acpCursorModelId).toBe("legacy-model");
  expect(snapshot.defaultCoreKind).toBe("acp");
  expect(snapshot.defaultAcpAgentId).toBe("cursor");

  // One-shot persist: new keys written, legacy keys deleted.
  const verifyDb = new sqlite.DatabaseSync(dbPath);
  const acpEnabled = verifyDb
    .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
    .get("acp_agents_enabled") as { value_json: string } | undefined;
  const acpModel = verifyDb
    .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
    .get("acp_cursor_model_id") as { value_json: string } | undefined;
  expect(acpEnabled && JSON.parse(acpEnabled.value_json)).toEqual({ cursor: true });
  expect(acpModel && JSON.parse(acpModel.value_json)).toBe("legacy-model");
  expect(
    verifyDb.prepare(`SELECT 1 AS ok FROM workflow_settings WHERE key = ?`).get("cursor_core_enabled"),
  ).toBeUndefined();
  expect(
    verifyDb.prepare(`SELECT 1 AS ok FROM workflow_settings WHERE key = ?`).get("cursor_model_id"),
  ).toBeUndefined();
  verifyDb.close();

  // Second get stays stable without legacy keys.
  expect(migrated.get()).toMatchObject({
    acpAgentsEnabled: { cursor: true },
    acpCursorModelId: "legacy-model",
    defaultCoreKind: "acp",
    defaultAcpAgentId: "cursor",
  });
});

test.skipIf(!sqliteAvailable)(
  "dynamic output defaults, persists, and preserves legacy fixed limits",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-output-mode-"));
    const dbPath = path.join(dir, "settings.db");
    const store = await createWorkflowSettingsStore(dbPath);
    expect(store.get().maxOutputLimitTokens).toBe("dynamic");
    expect(isWorkflowSettingsSnapshot({ sessionMode: "agent", maxOutputLimitTokens: "dynamic" })).toBe(true);
    expect(isWorkflowSettingsSnapshot({ sessionMode: "agent", maxOutputLimitTokens: "auto" })).toBe(false);
    store.save({ sessionMode: "agent", maxOutputLimitTokens: 65_536 });
    expect((await createWorkflowSettingsStore(dbPath)).get().maxOutputLimitTokens).toBe(65_536);
    store.save({ sessionMode: "agent", maxOutputLimitTokens: "dynamic" });
    expect((await createWorkflowSettingsStore(dbPath)).get().maxOutputLimitTokens).toBe("dynamic");
    await fs.rm(dir, { recursive: true, force: true });
  },
);
