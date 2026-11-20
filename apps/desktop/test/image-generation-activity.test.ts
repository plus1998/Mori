import { expect, test } from "bun:test";
import { readImageGenerationToolUseId } from "../src/renderer/ActivityLogView";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/conversation-v2-projection";

function item(tool: Record<string, unknown>): ThreadRunProjectionTimelineItem {
  return {
    id: "item-1",
    sequence: 1,
    eventType: "tool.started",
    scope: "main",
    text: "tool",
    at: "2026-08-09T00:00:00.000Z",
    metadata: { tool },
  };
}

test("activity image tool resolves only a reliable toolUseId", () => {
  expect(
    readImageGenerationToolUseId(
      item({ name: "mcp__mori_image_generation__create_image", toolUseId: " tool-1 " }),
    ),
  ).toBe("tool-1");
  expect(readImageGenerationToolUseId(item({ name: "Read", toolUseId: "tool-1" }))).toBeUndefined();
  expect(
    readImageGenerationToolUseId(item({ name: "mcp__mori_image_generation__create_image" })),
  ).toBeUndefined();
});
