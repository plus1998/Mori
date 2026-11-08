import { expect, test } from "bun:test";
import { createElement } from "react";
import { ImageGenerationSettingsPanel } from "../src/renderer/ImageGenerationSettingsPanel";
import type {
  ImageGenerationProfileSnapshot,
  ImageGenerationSettingsSnapshot,
} from "../src/shared/image-generation";
import { renderLocalized } from "./i18n-test";

function profile(
  overrides: Partial<ImageGenerationProfileSnapshot> & { id: string },
): ImageGenerationProfileSnapshot {
  return {
    name: "Profile",
    provider: "openai_compatible",
    endpoint: "https://example.com/v1",
    model: "gpt-image-2",
    supportsImageToImage: true,
    hasApiKey: true,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

const settings: ImageGenerationSettingsSnapshot = {
  enabled: true,
  activeProfileId: "p1",
  apiKeyEncryptionAvailable: true,
  profiles: [
    profile({ id: "p1", name: "GPT-image-2", model: "gpt-image-2" }),
    profile({
      id: "p2",
      name: "Google AI Studio",
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      supportsImageToImage: false,
    }),
  ],
};

test("uses vendor brand marks for creative drawing profile cards", () => {
  const markup = renderLocalized(
    createElement(ImageGenerationSettingsPanel, {
      settings,
      onChange: () => {},
      onError: () => {},
    }),
    "en-US",
  );
  // Vendor name > model > protocol decides the logo, assets come from the shipped icon sets.
  expect(markup).toContain('src="./provider-icons/openai.svg"');
  expect(markup).toContain('src="./agent-icons/gemini.png"');
  expect(markup).toContain("Creative Drawing");
  expect(markup).toContain("2 profiles");
  expect(markup).toContain("1 active");
  expect(markup).toContain("Supports image editing");
  expect(markup).toContain("Text-to-image only");
  expect(markup).not.toMatch(/[\u3400-\u9fff]/u);
});

test("keeps the state chip as the only activation control", () => {
  const markup = renderLocalized(
    createElement(ImageGenerationSettingsPanel, {
      settings,
      onChange: () => {},
      onError: () => {},
    }),
    "en-US",
  );
  const activeChip =
    markup.match(
      /<button(?=[^>]*class="settings-ui-resource-state")(?=[^>]*aria-pressed="true")[^>]*>/,
    )?.[0] ?? "";
  expect(activeChip).toContain('aria-pressed="true"');
  expect(activeChip).toContain("disabled");
  const inactiveChip =
    markup.match(
      /<button(?=[^>]*class="settings-ui-resource-state")(?=[^>]*aria-pressed="false")[^>]*>/,
    )?.[0] ?? "";
  expect(inactiveChip).toContain('aria-pressed="false"');
  expect(inactiveChip).not.toContain("disabled");
  // No separate activation button: the chip itself carries the click.
  expect(markup).not.toContain("image-generation-profile-action-primary");
  expect(markup).not.toContain("设为启用</button>");
});

test("Login goes directly to its account pool and preserves the existing Codex method", () => {
  const markup = renderLocalized(
    createElement(ImageGenerationSettingsPanel, {
      settings: {
        ...settings,
        apiKeyEncryptionAvailable: false,
        activeProfileId: "login",
        profiles: [
          ...settings.profiles,
          profile({ id: "login", name: "Old login profile", provider: "codex", hasApiKey: false }),
        ],
      },
      onChange: () => {},
      onError: () => {},
      onManageAccounts: () => {},
    }),
    "en-US",
  );
  expect(markup).toContain('value="chatgpt_login" selected=""');
  expect(markup).toContain('value="codex" selected=""');
  expect(markup).toContain("ChatGPT Login account pool");
  expect(markup).toContain("Manage login accounts");
  expect(markup).toContain("Plus / Team / Pro");
  expect(markup).not.toContain("Old login profile");
  expect(markup).not.toContain("Add profile");
  expect(markup).not.toContain("2 profiles");
  expect(markup).not.toMatch(/[\u3400-\u9fff]/u);
});

test("API profiles exclude legacy login cards and keep the API profile count", () => {
  const markup = renderLocalized(
    createElement(ImageGenerationSettingsPanel, {
      settings: {
        ...settings,
        profiles: [
          ...settings.profiles,
          profile({ id: "login", name: "Legacy web profile", provider: "chatgpt_web" }),
        ],
      },
      onChange: () => {},
      onError: () => {},
    }),
    "en-US",
  );
  expect(markup).toContain("2 profiles");
  expect(markup).not.toContain("Legacy web profile");
  expect(markup).not.toContain("ChatGPT Login account pool");
});
