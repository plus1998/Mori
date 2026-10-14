import { expect, test } from "bun:test";
import { ECO_IMAGE_VIEW_MCP_SERVER } from "@eco/runtime";
import { buildImageViewPromptAppend } from "../src/shared/image-view-tool";

test("prompt append names the image-view service and its vision capability", () => {
  const text = buildImageViewPromptAppend();
  expect(text).toContain(ECO_IMAGE_VIEW_MCP_SERVER);
  expect(text).toContain("returns a text answer");
  expect(text.toLowerCase()).not.toContain("integration");
  expect(text).toContain("view_image");
  expect(text).toContain("built-in OpenAI account");
});
