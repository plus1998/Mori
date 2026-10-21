import { expect, test } from "bun:test";
import { InMemoryCodexThreadMap, resolveCodexThreadAttribution } from "../src/main/codex-thread-map";

const ECO = "thr_eco_main";
const MAIN = "019fef91-eeca-76b2-a55e-688fffb375fe";
const CHILD = "019fefa5-e3f3-7cc3-a1e7-7f4977521642";

test("eco-mapped root stays planner even with a corrupted parent link", () => {
  const map = new InMemoryCodexThreadMap();
  map.setMapping(ECO, MAIN);
  // Corruption: main session wrongly stored as a child of a real subagent.
  map.setThreadAttribution(MAIN, {
    parentThreadId: CHILD,
    agentRole: "general",
  });
  // Legitimate child of main.
  map.setThreadAttribution(CHILD, {
    parentThreadId: MAIN,
    agentRole: "general",
  });

  // Refusal should leave no attribution on the root.
  expect(map.getThreadAttribution(MAIN)).toBeUndefined();

  // Even if we inject a raw parent edge that somehow exists, resolve must not
  // re-scope the eco-mapped root as a subagent.
  (map as unknown as { attributionByCodexThreadId: Map<string, unknown> }).attributionByCodexThreadId.set(
    MAIN,
    { parentThreadId: CHILD, agentRole: "general" },
  );

  expect(resolveCodexThreadAttribution(map, MAIN)).toEqual({
    ecoThreadId: ECO,
    billingRole: "main",
  });
  expect(resolveCodexThreadAttribution(map, CHILD)).toMatchObject({
    ecoThreadId: ECO,
    isSubagentThread: true,
    agentId: CHILD,
    billingRole: "general",
  });
});

test("child attribution still resolves through the parent root", () => {
  const map = new InMemoryCodexThreadMap();
  map.setMapping(ECO, MAIN);
  map.setThreadAttribution(CHILD, {
    parentThreadId: MAIN,
    agentRole: "coder",
  });

  expect(resolveCodexThreadAttribution(map, CHILD)).toEqual({
    ecoThreadId: ECO,
    billingRole: "coder",
    parentEcoThreadId: ECO,
    isSubagentThread: true,
    agentId: CHILD,
  });
});
