import { expect, test } from "bun:test";
import {
  ACP_IMAGE_ATTACHMENT_INVALID,
  ACP_IMAGE_CAPABILITY_MISSING,
  ACP_PROMPT_EMPTY,
  agentSupportsImagePrompt,
  buildAcpPromptBlocks,
} from "../src/acp-prompt.js";

const png = { mediaType: "image/png" as const, data: "abc" };

test("agentSupportsImagePrompt is true only for image === true", () => {
  expect(agentSupportsImagePrompt({ agentCapabilities: { promptCapabilities: { image: true } } })).toBe(true);
  expect(agentSupportsImagePrompt({ agentCapabilities: { promptCapabilities: { image: false } } })).toBe(
    false,
  );
  expect(agentSupportsImagePrompt({ agentCapabilities: { promptCapabilities: {} } })).toBe(false);
  expect(agentSupportsImagePrompt({})).toBe(false);
  expect(agentSupportsImagePrompt({ agentCapabilities: { promptCapabilities: { image: "true" } } })).toBe(
    false,
  );
});

test("buildAcpPromptBlocks returns a single text block when there are no attachments", () => {
  expect(buildAcpPromptBlocks({ prompt: "  hello  ", imageSupported: false })).toEqual([
    { type: "text", text: "hello" },
  ]);
});

test("buildAcpPromptBlocks throws when prompt and attachments are both empty", () => {
  expect(() => buildAcpPromptBlocks({ prompt: "  ", imageSupported: true })).toThrow(ACP_PROMPT_EMPTY);
});

test("buildAcpPromptBlocks prepends text then image blocks in input order", () => {
  expect(
    buildAcpPromptBlocks({
      prompt: "look",
      attachments: [png, { mediaType: "image/jpeg", data: "def" }],
      imageSupported: true,
    }),
  ).toEqual([
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", data: "abc" },
    { type: "image", mimeType: "image/jpeg", data: "def" },
  ]);
});

test("buildAcpPromptBlocks sends only images when text is empty or blank", () => {
  for (const prompt of ["", "   "]) {
    expect(buildAcpPromptBlocks({ prompt, attachments: [png], imageSupported: true })).toEqual([
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
  }
});

test("buildAcpPromptBlocks throws when attachments exist but image is unsupported", () => {
  expect(() => buildAcpPromptBlocks({ prompt: "look", attachments: [png], imageSupported: false })).toThrow(
    ACP_IMAGE_CAPABILITY_MISSING,
  );
});

test("buildAcpPromptBlocks throws for attachments missing inline data", () => {
  expect(() =>
    buildAcpPromptBlocks({
      prompt: "look at this",
      attachments: [{ mediaType: "image/png", path: "/tmp/test.png" } as { mediaType: "image/png"; data: string }],
      imageSupported: true,
    }),
  ).toThrow(ACP_IMAGE_ATTACHMENT_INVALID);
});

test("buildAcpPromptBlocks throws for blank data or illegal mime", () => {
  expect(() =>
    buildAcpPromptBlocks({
      prompt: "look",
      attachments: [{ mediaType: "image/png", data: "  " }],
      imageSupported: true,
    }),
  ).toThrow(ACP_IMAGE_ATTACHMENT_INVALID);
  expect(() =>
    buildAcpPromptBlocks({
      prompt: "look",
      attachments: [{ mediaType: "image/svg+xml" as "image/png", data: "abc" }],
      imageSupported: true,
    }),
  ).toThrow(ACP_IMAGE_ATTACHMENT_INVALID);
});
