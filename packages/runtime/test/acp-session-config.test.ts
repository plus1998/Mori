import { expect, test } from "bun:test";
import { parseAcpAvailableModels, resolveAcpWireModelId } from "../src/acp-session-config.js";

test("resolveAcpWireModelId prefers exact ACP modelId", () => {
  expect(
    resolveAcpWireModelId("composer-2.5[fast=true]", [
      { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
    ]),
  ).toBe("composer-2.5[fast=true]");
});

test("resolveAcpWireModelId maps auto and bare ids onto wire forms", () => {
  const available = [
    { modelId: "default[]", name: "Auto" },
    { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
  ];
  expect(resolveAcpWireModelId("auto", available)).toBe("default[]");
  expect(resolveAcpWireModelId("composer-2.5", available)).toBe("composer-2.5[fast=true]");
});

test("resolveAcpWireModelId rejects an unadvertised variant of a supported model", () => {
  expect(() => resolveAcpWireModelId("composer-2.5[fast=true]", [
    { modelId: "composer-2.5[fast=false]", name: "composer-2.5" },
  ])).toThrow(/not in availableModels/);
});

test("resolveAcpWireModelId throws when availableModels is missing", () => {
  expect(() => resolveAcpWireModelId("auto", [])).toThrow(/availableModels missing/);
});

test("resolveAcpWireModelId throws when id cannot be mapped", () => {
  expect(() => resolveAcpWireModelId("nope", [{ modelId: "default[]", name: "Auto" }])).toThrow(
    /not in availableModels/,
  );
});

test("parseAcpAvailableModels reads session/new or session/load models", () => {
  expect(
    parseAcpAvailableModels({
      sessionId: "s",
      models: {
        availableModels: [
          { modelId: "default[]", name: "Auto" },
          { modelId: "x", name: 1 },
        ],
      },
    }),
  ).toEqual([{ modelId: "default[]", name: "Auto" }, { modelId: "x" }]);
  expect(
    parseAcpAvailableModels({
      models: {
        availableModels: [{ modelId: "composer-2.5[fast=true]", name: "composer-2.5" }],
      },
    }),
  ).toEqual([{ modelId: "composer-2.5[fast=true]", name: "composer-2.5" }]);
});
