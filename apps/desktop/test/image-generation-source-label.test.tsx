import { expect, test } from "bun:test";
import { createElement } from "react";
import { ImageGenerationSourceLabel } from "../src/renderer/ImageGenerationSourceLabel";
import { renderLocalized } from "./i18n-test";

test("API results display the saved provider name", () => {
  const markup = renderLocalized(
    createElement(ImageGenerationSourceLabel, {
      provider: "openai_compatible",
      profileName: "My image API",
    }),
    "zh-CN",
  );
  expect(markup).toContain("My image API");
});

test("Login results display every saved account rather than the managed profile name", () => {
  const markup = renderLocalized(
    createElement(ImageGenerationSourceLabel, {
      provider: "chatgpt_web",
      profileName: "Managed Login",
      accounts: [
        { id: "a", name: "Account A", email: "a@example.com" },
        { id: "b", name: "Account B" },
      ],
    }),
    "zh-CN",
  );
  expect(markup).toContain("ChatGPT Login");
  expect(markup).toContain("Account A (a@example.com)、Account B");
  expect(markup).not.toContain("Managed Login");
});

test("legacy Login results explicitly say the generation account was not recorded", () => {
  for (const provider of ["codex", "chatgpt_web"] as const) {
    const element = createElement(ImageGenerationSourceLabel, { provider, profileName: "Old pool" });
    expect(renderLocalized(element, "zh-CN")).toContain("生成账号未记录");
    expect(renderLocalized(element, "en-US")).toContain("Generation account not recorded");
  }
});
