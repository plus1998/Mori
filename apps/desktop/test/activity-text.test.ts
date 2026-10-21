import { expect, test } from "bun:test";
import {
  logSuspiciousActivityLine,
  repairActivityText,
  resetSuspiciousActivityLogCache,
} from "../src/shared/activity-text";

test("thinking role is not flagged for suspicious activity log", () => {
  resetSuspiciousActivityLogCache();
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args[0]);
  };
  try {
    logSuspiciousActivityLine("thr_1", {
      id: "act_1",
      role: "thinking",
      message:
        "**Continuing from plan context**\n\nI realize that the previous assistant's tool calls are part of the history.",
    });
    logSuspiciousActivityLine("thr_1", {
      id: "act_1",
      role: "thinking",
      message: "duplicate call should not log again",
    });
  } finally {
    console.warn = original;
  }
  expect(warnings).toHaveLength(0);
});

test("logSuspiciousActivityLine dedupes by thread and line id", () => {
  resetSuspiciousActivityLogCache();
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args[0]);
  };
  try {
    const message = "X y Z broken mojibake pattern trigger";
    const { suspicious } = repairActivityText("I need to Fix The Code");
    expect(suspicious).toBe(true);

    logSuspiciousActivityLine("thr_1", { id: "act_2", role: "main", message: "I need to Fix The Code" });
    logSuspiciousActivityLine("thr_1", { id: "act_2", role: "main", message: "I need to Fix The Code" });
    void message;
  } finally {
    console.warn = original;
  }
  expect(warnings).toHaveLength(1);
});

test("repairActivityText removes internal web citation tokens", () => {
  const { text, repaired } = repairActivityText("模型输出。 citeturn0search0turn0search3");

  expect(text).toBe("模型输出。 ");
  expect(repaired).toBe(true);
});
