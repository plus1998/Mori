import { expect, test } from "bun:test";
import { parseThreadRunCodemodeMetadata } from "../src/shared/thread-run-events";
import {
  isCodemodeToolName,
  keepsOutputPreview,
  projectThreadRunToolMetadata,
  resolveCodemodeMetadata,
} from "../src/shared/thread-run-tool-projection";

test("codemode keeps its script output in the durable tool row", () => {
  expect(keepsOutputPreview("codemode")).toBe(true);
  expect(keepsOutputPreview("Bash")).toBe(true);
  expect(keepsOutputPreview("read")).toBe(false);
  expect(isCodemodeToolName("CodeMode")).toBe(true);
});

test("resolveCodemodeMetadata lifts the script out of the call input", () => {
  const resolved = resolveCodemodeMetadata({
    name: "codemode",
    callInput: { code: '// @options: {"timeout_ms": 1000}\nreturn ALL_TOOLS.length;' },
    output: "Script completed\nWall time 1.20 seconds\nOutput:\n12\n",
  });
  expect(resolved?.script).toContain("ALL_TOOLS.length");
  // PI's header is presentation, not content: the card labels the block itself.
  expect(resolved?.output).toBe("12");
});

test("resolveCodemodeMetadata keeps PI's failure tail and non-codemode tools out", () => {
  const failed = resolveCodemodeMetadata({
    name: "codemode",
    callInput: { code: "tools.read({});" },
    output: "Script failed\nWall time 0.40 seconds\nOutput:\npartial\n\nScript error: Error: boom",
  });
  expect(failed?.output).toContain("Script error: Error: boom");
  expect(
    resolveCodemodeMetadata({ name: "bash", callInput: { command: "ls" }, output: "x" }),
  ).toBeUndefined();
});

test("resolveCodemodeMetadata carries PI's nested-call details", () => {
  const resolved = resolveCodemodeMetadata({
    name: "codemode",
    callInput: { code: "return 1;" },
    details: {
      fullOutputPath: "/tmp/pi-out-1.txt",
      calls: [
        { id: "code_1/1", name: "read", args: '{"path":"a.ts"}', status: "ok", durationMs: 120 },
        { id: "code_1/2", name: "models.classify", status: "error", cost: 0.004, error: "nope" },
        { id: "code_1/3", name: "bash", args: '{"command":"ls"}', status: "cancelled" },
      ],
    },
  });
  expect(resolved?.fullOutputPath).toBe("/tmp/pi-out-1.txt");
  expect(resolved?.calls?.map((call) => [call.name, call.status])).toEqual([
    ["read", "ok"],
    ["models.classify", "error"],
    ["bash", "cancelled"],
  ]);
  expect(resolved?.calls?.[0]?.durationMs).toBe(120);
  expect(resolved?.calls?.[1]?.cost).toBeCloseTo(0.004);
});

test("the tool metadata projection keeps the link to the script that made the call", () => {
  // The projection rebuilds the metadata field by field; a call that loses its parent is drawn as a
  // command the model issued, not as one of the script's own.
  const projected = projectThreadRunToolMetadata({
    name: "Bash",
    toolUseId: "code_1/1",
    parentToolCallId: "code_1",
    detail: "echo one",
  });
  expect(projected?.parentToolCallId).toBe("code_1");
});

test("parseThreadRunCodemodeMetadata drops empty and oversized payloads", () => {
  expect(parseThreadRunCodemodeMetadata({})).toBeUndefined();
  expect(parseThreadRunCodemodeMetadata(undefined)).toBeUndefined();
  expect(parseThreadRunCodemodeMetadata({ calls: [{ args: "{}" }] })).toBeUndefined();
  const big = parseThreadRunCodemodeMetadata({
    script: "x".repeat(20_000),
    output: "y".repeat(20_000),
    calls: Array.from({ length: 200 }, (_unused, index) => ({ name: `t${index}` })),
  });
  expect(big?.script).toHaveLength(12_000);
  expect(big?.output).toHaveLength(8_000);
  expect(big?.calls).toHaveLength(64);
});
