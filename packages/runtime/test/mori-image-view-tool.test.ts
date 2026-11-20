import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ECO_IMAGE_VIEW_FULL_TOOL as NAMED_FULL_TOOL,
  isEcoImageViewToolName as namedIsEcoImageViewToolName,
} from "../src/mori-image-view-names";
import {
  ECO_IMAGE_VIEW_FULL_TOOL,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
  readImageViewPathFromToolArgs,
  resolveEcoImageViewToolCall,
  resolvePiMcpProxyDiscoveryCall,
} from "../src/mori-image-view-tool";

test("recognizes Eco image view MCP names", () => {
  expect(isEcoImageViewToolName(ECO_IMAGE_VIEW_FULL_TOOL)).toBe(true);
  expect(isEcoImageViewToolName(`mcp__${ECO_IMAGE_VIEW_MCP_SERVER}__${ECO_IMAGE_VIEW_TOOL}`)).toBe(true);
  expect(isEcoImageViewToolName("mcp__mori_image_generation__create_image")).toBe(false);
  expect(isEcoImageViewToolName("ViewImage")).toBe(false);
  expect(isEcoImageViewToolName("view_image")).toBe(false);
});

test("image view names module stays usable in the Vite renderer", () => {
  const source = readFileSync(new URL("../src/mori-image-view-names.ts", import.meta.url), "utf8");
  expect(source).not.toContain("node:");
  // Renderer-safe: must not pull the Node-only PI runtime (the guard named the
  // removed pi-mcp-adapter before PI 1.0.3).
  expect(source).not.toContain("@earendil-works/");
  expect(namedIsEcoImageViewToolName(NAMED_FULL_TOOL)).toBe(true);
});

test("readImageViewPathFromToolArgs only returns absolute paths for Eco view_image", () => {
  expect(readImageViewPathFromToolArgs(ECO_IMAGE_VIEW_FULL_TOOL, { path: "/tmp/a.png" })).toBe("/tmp/a.png");
  expect(readImageViewPathFromToolArgs(ECO_IMAGE_VIEW_FULL_TOOL, { path: "relative.png" })).toBe(undefined);
  expect(readImageViewPathFromToolArgs("Read", { path: "/tmp/a.png" })).toBe(undefined);
});

test("readImageViewPathFromToolArgs unwraps PI mcp proxy view_image calls", () => {
  expect(
    readImageViewPathFromToolArgs("mcp", {
      tool: "view_image",
      server: "mori_image_view",
      args: '{"path":"/tmp/shot.png"}',
    }),
  ).toBe("/tmp/shot.png");
  expect(
    readImageViewPathFromToolArgs("mcp", {
      tool: "view_image",
      args: { path: "/Users/gareth/Downloads/IMG_2743.jpg" },
    }),
  ).toBe("/Users/gareth/Downloads/IMG_2743.jpg");
  expect(
    readImageViewPathFromToolArgs("mcp", {
      tool: "view_image",
      args: '{"path":"relative.png"}',
    }),
  ).toBe(undefined);
  expect(
    readImageViewPathFromToolArgs("mcp", {
      search: "view image",
    }),
  ).toBe(undefined);
  expect(
    resolveEcoImageViewToolCall("mcp", {
      tool: "view_image",
      server: "mori_image_view",
      args: '{"path":"/tmp/shot.png"}',
    }),
  ).toEqual({
    name: ECO_IMAGE_VIEW_FULL_TOOL,
    path: "/tmp/shot.png",
  });
});

test("PI mcp proxy view_image calls keep the caller's prompt, not just the path", () => {
  // 真实 PI 会话里这一句（server 字段缺省，tool 写成 <server>_<tool>）：
  //   mcp({ tool: "mori_image_view_view_image", args: { path, prompt } })
  expect(
    resolveEcoImageViewToolCall("mcp", {
      tool: "mori_image_view_view_image",
      args: { path: "/tmp/left_circle.png", prompt: "这幅图是奖章正面。请回答：(1) 人像特征" },
    }),
  ).toEqual({
    name: ECO_IMAGE_VIEW_FULL_TOOL,
    path: "/tmp/left_circle.png",
    prompt: "这幅图是奖章正面。请回答：(1) 人像特征",
  });
  // 旧字段 question 仍按同一个提示词读取。
  expect(
    resolveEcoImageViewToolCall("mcp", {
      tool: "mori_image_view_view_image",
      args: { path: "/tmp/left_circle.png", question: "找报错" },
    }),
  ).toEqual({ name: ECO_IMAGE_VIEW_FULL_TOOL, path: "/tmp/left_circle.png", prompt: "找报错" });
});

test("resolvePiMcpProxyDiscoveryCall labels PI mcp search/action probes", () => {
  expect(resolvePiMcpProxyDiscoveryCall("mcp", { search: "view image" })).toEqual({ kind: "search" });
  expect(resolvePiMcpProxyDiscoveryCall("mcp", { action: "list_tools" })).toEqual({ kind: "search" });
  expect(resolvePiMcpProxyDiscoveryCall("mcpScript", { search: "" })).toEqual({ kind: "search" });
  expect(
    resolvePiMcpProxyDiscoveryCall("mcp", {
      tool: "view_image",
      args: { path: "/tmp/shot.png" },
    }),
  ).toBe(undefined);
  expect(resolvePiMcpProxyDiscoveryCall("mcp__mori_image_view__view_image", { search: "x" })).toBe(undefined);
});
