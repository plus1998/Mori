import { expect, test } from "bun:test";
import { imageGenerationAvailability } from "../src/main/image-generation-availability";
import type { ImageGenerationSettingsSnapshot } from "../src/shared/image-generation";

function settings(provider: "codex" | "chatgpt_web" | "openai" = "codex"): ImageGenerationSettingsSnapshot {
  return {
    enabled: true,
    activeProfileId: "p1",
    apiKeyEncryptionAvailable: false,
    profiles: [
      {
        id: "p1",
        name: "Images",
        provider,
        endpoint: "https://chatgpt.com/backend-api/codex",
        model: "gpt-image-2",
        supportsImageToImage: true,
        hasApiKey: false,
        createdAt: "",
        updatedAt: "",
      },
    ],
  };
}

test("Composer accepts eligible Codex login accounts without API keys or key encryption", () => {
  expect(imageGenerationAvailability(settings(), { available: true })).toEqual({ available: true });
});
test("Composer accepts Free accounts through the web image channel without an API key", () => {
  expect(imageGenerationAvailability(settings("chatgpt_web"), { available: true })).toEqual({
    available: true,
  });
});
test("Codex account eligibility errors replace the unrelated missing API Key warning", () => {
  expect(
    imageGenerationAvailability(settings(), { available: false, reason: "Free 套餐需要 Plus / Team / Pro" }),
  ).toEqual({ available: false, reason: "Free 套餐需要 Plus / Team / Pro" });
});
test("regular providers still require configured, decryptable API keys", () => {
  const input = settings("openai");
  expect(imageGenerationAvailability(input).reason).toContain("尚未配置 API Key");
  input.profiles[0]!.hasApiKey = true;
  expect(imageGenerationAvailability(input).reason).toContain("系统加密不可用");
  input.apiKeyEncryptionAvailable = true;
  expect(imageGenerationAvailability(input)).toEqual({ available: true });
});
test("disabled drawing stays unavailable even with eligible Codex accounts", () => {
  expect(imageGenerationAvailability({ ...settings(), enabled: false }, { available: true }).available).toBe(
    false,
  );
});
