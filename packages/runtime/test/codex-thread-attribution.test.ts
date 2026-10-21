import { expect, test } from "bun:test";
import { resolveDefaultCodexThreadAttribution } from "../src/codex-thread-attribution.js";

test("main Codex threads default to planner attribution", () => {
  expect(
    resolveDefaultCodexThreadAttribution({
      codexThreadId: "thr_codex_main",
      ecoThreadId: "thr_eco_main",
    }),
  ).toEqual({
    ecoThreadId: "thr_eco_main",
    billingRole: "main",
  });
});

test("child Codex threads without a role use neutral subagent attribution", () => {
  expect(
    resolveDefaultCodexThreadAttribution({
      codexThreadId: "thr_codex_child",
      ecoThreadId: "thr_eco_main",
      parentThreadId: "thr_codex_parent",
      parentEcoThreadId: "thr_eco_main",
    }),
  ).toEqual({
    ecoThreadId: "thr_eco_main",
    billingRole: "subagent",
    parentEcoThreadId: "thr_eco_main",
    isSubagentThread: true,
  });
});

test("child Codex threads preserve an explicit orchestration role", () => {
  expect(
    resolveDefaultCodexThreadAttribution({
      codexThreadId: "thr_codex_child",
      ecoThreadId: "thr_eco_main",
      parentThreadId: "thr_codex_parent",
      agentRole: "reviewer",
    }),
  ).toEqual({
    ecoThreadId: "thr_eco_main",
    billingRole: "reviewer",
    parentEcoThreadId: "thr_eco_main",
    isSubagentThread: true,
  });
});
