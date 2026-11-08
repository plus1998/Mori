import { expect, test } from "bun:test";
import { projectionTimelineItemRenderSignature as signature } from "../src/renderer/projection-timeline-signature";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/ipc";

test("settled items serialize metadata once across repeated Feed comparisons", () => {
  let serializations = 0;
  const item: ThreadRunProjectionTimelineItem = {
    id: "item",
    sequence: 1,
    eventType: "message.final",
    scope: "main",
    at: "2026-11-08T00:00:00Z",
    text: "long answer".repeat(10_000),
    metadata: {
      toJSON() {
        serializations++;
        return { value: 1 };
      },
    },
  };
  const before = signature(item);
  for (let i = 0; i < 100; i++) expect(signature(item)).toBe(before);
  expect(serializations).toBe(1);
  expect(signature({ ...item, text: `${item.text}!` })).not.toBe(before);
  expect(signature({ ...item, metadata: { value: 2 } })).not.toBe(before);
  expect(signature({ ...item, contentLoaded: true })).not.toBe(before);
  expect(signature({ ...item, runAttemptId: "new-run" })).not.toBe(before);
  expect(signature({ ...item })).toBe(before);
});
