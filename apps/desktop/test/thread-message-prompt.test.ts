import { expect, test } from "bun:test";
import { resolveThreadMessagePrompt } from "../src/main/thread-message-prompt";

test("resolveThreadMessagePrompt preserves empty or missing prompt text", () => {
  expect(resolveThreadMessagePrompt(undefined)).toBe("");
  expect(resolveThreadMessagePrompt("   ")).toBe("");
});

test("resolveThreadMessagePrompt keeps explicit prompt text", () => {
  expect(resolveThreadMessagePrompt("  describe this  ")).toBe("describe this");
});
