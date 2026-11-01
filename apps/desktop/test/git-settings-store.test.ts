import { expect, test } from "bun:test";
import {
  defaultGitSettings,
  isGitSettingsSnapshot,
  normalizeGitSettingsSnapshot,
} from "../src/main/git-settings-store";

test("legacy per-config Git preferences are removed while instructions remain", () => {
  expect(normalizeGitSettingsSnapshot({
    commitMessageRoleByMainAgentConfigId: { old: "explore" },
    commitMessageCandidateModelIdByMainAgentConfigId: { old: "cand-1" },
    commitMessageInstructions: "  使用中文  ",
  })).toEqual({
    commitMessageInstructions: "使用中文",
    autofetch: true,
    autofetchPeriod: 180,
  });
});

test("Git settings accept current values and reject removed per-config fields", () => {
  expect(isGitSettingsSnapshot(defaultGitSettings())).toBe(true);
  expect(isGitSettingsSnapshot({ commitMessageRoleByMainAgentConfigId: {} })).toBe(false);
});
