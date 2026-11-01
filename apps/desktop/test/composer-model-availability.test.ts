import { expect, test } from "bun:test";
import type { ComposerModelOption } from "../src/renderer/composer-model-availability";
import {
  composerRequiresOrchestration,
  composerShowsRouteConfig,
  resolveComposerModelAvailability,
} from "../src/renderer/composer-model-availability";

const templateModel: ComposerModelOption = {
  providerId: "p1",
  providerName: "Provider 1",
  modelId: "gpt-4",
};

test("resolveComposerModelAvailability returns no-provider when providers empty", () => {
  expect(resolveComposerModelAvailability([], templateModel)).toBe("no-provider");
  expect(resolveComposerModelAvailability([], undefined)).toBe("no-provider");
});

test("resolveComposerModelAvailability returns no-provider when all providers disabled", () => {
  expect(resolveComposerModelAvailability([{ enabled: false }, { enabled: false }], templateModel)).toBe(
    "no-provider",
  );
});

test("resolveComposerModelAvailability returns no-orchestration when enabled provider but no template model", () => {
  expect(resolveComposerModelAvailability([{ enabled: true }], undefined)).toBe("no-orchestration");
  expect(resolveComposerModelAvailability([{ enabled: false }, { enabled: true }], undefined)).toBe(
    "no-orchestration",
  );
});

test("resolveComposerModelAvailability returns ready when enabled provider and template model exist", () => {
  expect(resolveComposerModelAvailability([{ enabled: true }], templateModel)).toBe("ready");
  expect(resolveComposerModelAvailability([{ enabled: false }, { enabled: true }], templateModel)).toBe(
    "ready",
  );
});

test("ACP does not require Eco runtime configuration or providers", () => {
  expect(composerRequiresOrchestration("acp")).toBe(false);
  expect(composerRequiresOrchestration("claude")).toBe(true);
  expect(composerRequiresOrchestration("codex")).toBe(true);
  expect(composerRequiresOrchestration("pi")).toBe(true);
  expect(composerShowsRouteConfig("acp")).toBe(true);
  expect(composerShowsRouteConfig("claude")).toBe(true);
  expect(resolveComposerModelAvailability([], undefined, "acp")).toBe("acp");
  expect(resolveComposerModelAvailability([{ enabled: false }], undefined, "acp")).toBe("acp");
});
