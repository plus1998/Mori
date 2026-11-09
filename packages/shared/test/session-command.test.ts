import { expect, test } from "bun:test";
import { isCompactCommand } from "../src/session-command";

test("recognizes only a standalone /compact command", () => {
  for (const text of ["/compact", " /compact \n", "\t/compact"]) expect(isCompactCommand(text)).toBe(true);
  for (const text of [
    "",
    "/compaction",
    "/compactly",
    "说明 /compact",
    "`/compact`",
    "/compact\n继续任务",
    "/compact extra",
  ]) {
    expect(isCompactCommand(text)).toBe(false);
  }
});
