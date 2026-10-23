import { expect, test } from "bun:test";
import { buildPromptWithImageReferences } from "../src/shared/prompt-image-reference";

test("main prompt carries a path handle without embedding image bytes", () => {
  const data = "a".repeat(4096);
  const prompt = buildPromptWithImageReferences({
    prompt: "请检查图片",
    attachments: [
      {
        mediaType: "image/png",
        path: "/tmp/prompt-image.png",
        contentRef: "sha256:abc",
        data,
      },
    ],
  });

  expect(prompt).toContain('path="/tmp/prompt-image.png"');
  expect(prompt).not.toContain(data);
});

test("main prompt falls back to the durable ref when no path is available", () => {
  const prompt = buildPromptWithImageReferences({
    prompt: "describe it",
    attachments: [
      {
        mediaType: "image/jpeg",
        contentRef: "sha256:abc",
        data: "YWJj",
      },
    ],
  });

  expect(prompt).toContain('ref="sha256:abc"');
  expect(prompt).not.toContain("YWJj");
});

test("image-only prompts carry tool references without adding a user instruction", () => {
  const prompt = buildPromptWithImageReferences({
    prompt: "",
    attachments: [{ mediaType: "image/png", path: "/tmp/prompt-image.png" }],
  });
  expect(prompt).toContain('path="/tmp/prompt-image.png"');
  expect(prompt.startsWith("Composer image references")).toBe(true);
  expect(prompt).not.toContain("Use the supplied image references");
});
