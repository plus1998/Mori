import { expect, test } from "bun:test";
import {
  resolveEcoMcpHubSearchCall,
  resolveEcoMcpHubToolCall,
} from "../src/mori-mcp-hub-tool";

test("unwraps a Hub call into the nested canonical tool and arguments", () => {
  expect(
    resolveEcoMcpHubToolCall("mcp__mori_mcp__call_tool", {
      name: "mori_image_view:view_image",
      arguments: { path: "/tmp/example.png", prompt: "describe" },
    }),
  ).toEqual({
    name: "mcp__mori_image_view__view_image",
    args: { path: "/tmp/example.png", prompt: "describe" },
  });
});

test("accepts JSON encoded Hub arguments and labels search calls", () => {
  expect(
    resolveEcoMcpHubToolCall("mcp__mori_mcp__call_tool", {
      name: "mori_web_search:search",
      arguments: '{"query":"Eco MCP"}',
    }),
  ).toEqual({ name: "mcp__mori_web_search__search", args: { query: "Eco MCP" } });
  expect(resolveEcoMcpHubSearchCall("mcp__mori_mcp__search_tools", { query: "image" })).toEqual({
    query: "image",
  });
});

test("does not invent a nested target for malformed Hub calls", () => {
  expect(resolveEcoMcpHubToolCall("mcp__mori_mcp__call_tool", { name: "call_tool" })).toBeUndefined();
  expect(resolveEcoMcpHubToolCall("mcp__other__call_tool", { name: "mori_image_view:view_image" })).toBeUndefined();
});

test("unwraps per-thread Hub server names from the Codex runtime", () => {
  expect(
    resolveEcoMcpHubToolCall("mcp__mori_mcp_4b6e103b_thr_1790688274221__call_tool", {
      name: "mori_image_view:view_image",
      arguments: { path: "/tmp/example.png", prompt: "describe" },
    }),
  ).toEqual({
    name: "mcp__mori_image_view__view_image",
    args: { path: "/tmp/example.png", prompt: "describe" },
  });
});

test("labels per-thread Hub search calls", () => {
  expect(
    resolveEcoMcpHubSearchCall("mcp__mori_mcp_4b6e103b_thr_1790688274221__search_tools", {
      query: "mori_image_view:view_image",
    }),
  ).toEqual({ query: "mori_image_view:view_image" });
});

test("does not unwrap non-wrapper tools under a per-thread Hub server", () => {
  expect(
    resolveEcoMcpHubToolCall("mcp__mori_mcp_4b6e103b_thr_1790688274221__other_tool", {
      name: "mori_image_view:view_image",
      arguments: {},
    }),
  ).toBeUndefined();
  expect(
    resolveEcoMcpHubToolCall("mcp__mori_mcp_4b6e103b_thr_1790688274221__call_tool", {
      name: "call_tool",
      arguments: {},
    }),
  ).toBeUndefined();
});

test("keeps legacy flat Hub names working", () => {
  expect(
    resolveEcoMcpHubToolCall("eco_mcp_call_tool", {
      name: "eco_web_search:search",
      arguments: { query: "x" },
    }),
  ).toEqual({ name: "mcp__mori_web_search__search", args: { query: "x" } });
});
