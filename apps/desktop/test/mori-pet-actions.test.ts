import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MoriAssistantStore, parseAssistantSettings } from "../src/main/mori-assistant-store";
import { DEFAULT_MORI_ASSISTANT_SETTINGS } from "../src/shared/mori-assistant";
import {
  DEFAULT_MORI_PET_ACTIONS,
  type MoriPetActionState,
  moriPetAction,
  moriPetActionState,
} from "../src/shared/mori-pet-actions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("every interaction retains its original default action", () => {
  expect(DEFAULT_MORI_PET_ACTIONS).toEqual({
    idle: "idle",
    running: "running",
    waiting: "waiting",
    error: "failed",
    greeting: "waving",
    "drag-right": "running-right",
    "drag-left": "running-left",
    completion: "jumping",
    "completion-review": "review",
    "task-failed": "failed",
    approval: "waiting",
    question: "waiting",
    looking: "look",
  });
  for (const state of Object.keys(DEFAULT_MORI_PET_ACTIONS) as MoriPetActionState[]) {
    expect(moriPetAction(state, {})).toBe(DEFAULT_MORI_PET_ACTIONS[state]);
    expect(moriPetAction(state, { [state]: "jumping" })).toBe("jumping");
  }
  expect(moriPetAction("waiting", { running: "jumping" })).toBe("waiting");
});

test("drag, greeting and notifications keep priority over gaze and persistent status", () => {
  const input: Parameters<typeof moriPetActionState>[0] = {
    status: "running",
    version: 2,
    direction: 0,
    drag: "drag-right",
    greeting: true,
    reaction: "completion",
  };
  expect(moriPetActionState(input)).toBe("drag-right");
  expect(moriPetActionState({ ...input, drag: "drag-left" })).toBe("drag-left");
  expect(moriPetActionState({ ...input, drag: undefined })).toBe("greeting");
  expect(moriPetActionState({ ...input, drag: undefined, greeting: false })).toBe("completion");
  const persistent = { ...input, drag: undefined, greeting: false, reaction: undefined };
  for (const status of ["idle", "running", "waiting", "error"] as const) {
    expect(moriPetActionState({ ...persistent, status })).toBe(status === "error" ? "error" : "looking");
    expect(moriPetActionState({ ...persistent, status, direction: null })).toBe(status);
    expect(moriPetActionState({ ...persistent, status, version: 1 })).toBe(status);
  }
  for (const reaction of ["completion-review", "task-failed", "approval", "question"] as const)
    expect(moriPetActionState({ ...persistent, reaction })).toBe(reaction);
  // Choosing idle for an interaction must not turn it into pointer tracking.
  expect(moriPetAction("greeting", { greeting: "idle" })).toBe("idle");
  expect(moriPetAction("looking", { looking: "running" })).toBe("running");
});

test("legacy settings keep defaults and overrides survive saves independently per pet", async () => {
  const { petActions: _omitted, ...legacy } = DEFAULT_MORI_ASSISTANT_SETTINGS;
  expect(parseAssistantSettings(legacy).petActions).toEqual({});
  const settings = parseAssistantSettings({
    ...legacy,
    petActions: {
      "builtin:mori": { running: "review" },
      "codex:doro": { running: "jumping", looking: "idle" },
      "codex-home:cat": { greeting: "waiting" },
      "mori:imported": { error: "waving" },
    },
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-pet-actions-"));
  roots.push(root);
  const store = new MoriAssistantStore(path.join(root, "assistant.json"));
  store.state.settings = settings;
  await store.save();
  const restored = new MoriAssistantStore(store.filePath);
  await restored.load();
  expect(restored.state.settings.petActions).toEqual(settings.petActions);
  expect(moriPetAction("running", restored.state.settings.petActions["builtin:mori"]!)).toBe("review");
  expect(moriPetAction("running", restored.state.settings.petActions["codex:doro"]!)).toBe("jumping");
  const reset = { ...restored.state.settings.petActions };
  delete reset["codex:doro"];
  expect(moriPetAction("running", reset["codex:doro"] ?? {})).toBe("running");
  expect(reset["builtin:mori"]).toEqual({ running: "review" });
});

test("invalid pet keys, states and actions fail explicitly", () => {
  for (const petActions of [
    null,
    [],
    "idle",
    { "other:pet": {} },
    { "codex:../pet": {} },
    { "codex:pet": null },
    { "codex:pet": [] },
    { "codex:pet": "idle" },
    { "codex:pet": { unknown: "idle" } },
    { "codex:pet": { running: "unknown" } },
    { "codex:pet": { running: "look" } },
    { "codex:pet": { running: null } },
    { "codex:pet": { running: "__proto__" } },
    { "codex:pet": JSON.parse('{"__proto__":"idle"}') },
  ])
    expect(() => parseAssistantSettings({ petActions })).toThrow("宠物动作设置无效");
  expect(parseAssistantSettings({ petActions: { "builtin:mori": { looking: "look" } } }).petActions).toEqual({
    "builtin:mori": { looking: "look" },
  });
});
