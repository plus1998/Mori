import { expect, test } from "bun:test";
import {
  createFinalizePlanMcpServer,
  isFinalizePlanSubmissionComplete,
  parseFinalizePlanInput,
} from "../src/finalize-plan";

test("parseFinalizePlanInput trims strings and defaults missing fields", () => {
  const parsed = parseFinalizePlanInput({
    analysis: "  a  ",
    plan: "\n\np\n",
    extra: 1,
  });
  expect(parsed.analysis).toBe("a");
  expect(parsed.plan).toBe("p");
  expect(parsed.rawInput).toHaveProperty("extra", 1);
});

test("parseFinalizePlanInput returns empty strings for non-string fields", () => {
  const parsed = parseFinalizePlanInput({
    analysis: 123,
    plan: null,
  } as unknown as Record<string, unknown>);
  expect(parsed.analysis).toBe("");
  expect(parsed.plan).toBe("");
});

test("isFinalizePlanSubmissionComplete requires both analysis and plan", () => {
  expect(isFinalizePlanSubmissionComplete({ analysis: "a", plan: "b" })).toBe(true);
  expect(isFinalizePlanSubmissionComplete({ analysis: "", plan: "b" })).toBe(false);
  expect(isFinalizePlanSubmissionComplete({ analysis: "a", plan: "  " })).toBe(false);
});

test("createFinalizePlanMcpServer passes timeout 60000 to createSdkMcpServer", async () => {
  const captured: Record<string, unknown>[] = [];
  await createFinalizePlanMcpServer(() => {}, {
    loadSdk: async () =>
      ({
        tool: ((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
          name: "finalize_plan",
          handler,
        })) as never,
        createSdkMcpServer: ((config: Record<string, unknown>) => {
          captured.push(config);
          return { name: config.name };
        }) as never,
      }) as typeof import("@anthropic-ai/claude-agent-sdk"),
  });

  expect(captured).toHaveLength(1);
  expect(captured[0]?.timeout).toBe(60_000);
  expect(captured[0]?.name).toBe("mori_plan");
});
