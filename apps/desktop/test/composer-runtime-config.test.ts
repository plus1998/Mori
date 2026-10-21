import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  shouldBlockCodexSkillsConfigReload,
  skillsEnabledSettingsChanged,
} from "../src/main/codex-skills-config-reload";
import { buildEffectiveComposerRuntimeConfig } from "../src/renderer/composer-runtime-config";
import type { ThreadRuntimeConfig } from "../src/shared/ipc";

const existingConfig: ThreadRuntimeConfig = {
  sessionMode: "agent",
  bashReviewMode: "allow_all",
  subagentEnabled: { explore: false, architect: false, coder: false, reviewer: false, tester: false },
};
const derivedChoices = {
  hasThread: true,
  skillsEnabled: { "project:local": true, "user:remembered": true, "user:disabled": false },
  mcpServersEnabled: { mongo: false },
  integrationsEnabled: { browser: true },
};

function blockedOnLoadedThread(previous: ThreadRuntimeConfig, next: ThreadRuntimeConfig): boolean {
  return shouldBlockCodexSkillsConfigReload({
    skillsChanged: skillsEnabledSettingsChanged(previous.skillsEnabled, next.skillsEnabled),
    hasCodexMapping: true,
    status: "idle",
  });
}

test("continuing an old Codex thread without saved Skills does not request a reload", () => {
  const next = buildEffectiveComposerRuntimeConfig(existingConfig, derivedChoices);
  assert(next);

  expect(Object.hasOwn(next, "skillsEnabled")).toBe(false);
  expect(blockedOnLoadedThread(existingConfig, next)).toBe(false);
  expect(next.sessionMode).toBe("agent");
});

test("continuation preserves a partial Skills snapshot when discovery and project preferences change", () => {
  const previous = {
    ...existingConfig,
    skillsEnabled: { "project:local": false, "user:no-longer-discovered": true },
  };
  const next = buildEffectiveComposerRuntimeConfig(previous, derivedChoices);
  assert(next);

  expect(next.skillsEnabled).toBe(previous.skillsEnabled);
  expect(blockedOnLoadedThread(previous, next)).toBe(false);
});

test("an explicit Skills edit still reaches the loaded-thread reload guard", () => {
  const editedConfig = { ...existingConfig, skillsEnabled: { "project:local": false } };
  const next = buildEffectiveComposerRuntimeConfig(editedConfig, derivedChoices);
  assert(next);

  expect(next.skillsEnabled).toEqual({ "project:local": false });
  expect(blockedOnLoadedThread(existingConfig, next)).toBe(true);
});

test("new threads inherit the derived Skills choices", () => {
  const next = buildEffectiveComposerRuntimeConfig(existingConfig, { ...derivedChoices, hasThread: false });
  assert(next);

  expect(next.skillsEnabled).toEqual(derivedChoices.skillsEnabled);
  expect(next.mcpServersEnabled).toEqual({ mongo: false });
  expect(next.integrationsEnabled).toEqual({ browser: true });
  expect(Object.hasOwn(existingConfig, "skillsEnabled")).toBe(false);
});

test("unconfigured Composer and empty new-thread Skills stay unconfigured", () => {
  expect(buildEffectiveComposerRuntimeConfig(null, derivedChoices)).toBeNull();
  const next = buildEffectiveComposerRuntimeConfig(existingConfig, {
    ...derivedChoices,
    hasThread: false,
    skillsEnabled: {},
  });
  assert(next);
  expect(Object.hasOwn(next, "skillsEnabled")).toBe(false);
});
