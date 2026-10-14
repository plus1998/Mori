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
  const activeChip = markup.match(/<button[^>]*image-generation-profile-status is-active[^>]*>/)?.[0] ?? "";
  expect(activeChip).toContain('aria-pressed="true"');
  expect(activeChip).toContain("disabled");
  const inactiveChip = markup.match(/<button[^>]*image-generation-profile-status"[^>]*>/)?.[0] ?? "";
  expect(inactiveChip).toContain('aria-pressed="false"');
  expect(inactiveChip).not.toContain("disabled");
  // No separate activation button: the chip itself carries the click.
  expect(markup).not.toContain("image-generation-profile-action-primary");
  expect(markup).not.toContain("设为启用</button>");
});
