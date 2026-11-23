import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  callAgentBrowserToolViaCli,
  mapAgentBrowserToolToCliArgs,
  resolveAgentBrowserTabSwitchArg,
  shouldRouteAgentBrowserToolsViaCli,
} from "../src/main/agent-browser-cli-bridge";

test("pre-cancelled browser calls reject before launching the CLI", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before dispatch");
  controller.abort(reason);
  await expect(callAgentBrowserToolViaCli({
    binaryPath: "/does-not-exist/agent-browser",
    cdpPort: 9333,
    sessionKey: "cancelled-session",
    toolName: "agent_browser_click",
    args: { ref: "@e2" },
    signal: controller.signal,
  })).rejects.toBe(reason);
});

test("shouldRouteAgentBrowserToolsViaCli defaults to CLI on all platforms", () => {
  expect(shouldRouteAgentBrowserToolsViaCli()).toBe(true);
});

test("mapAgentBrowserToolToCliArgs covers core browser tools", () => {
  expect(mapAgentBrowserToolToCliArgs("agent_browser_open", { url: "https://example.com" })).toEqual([
    "open",
    "https://example.com",
  ]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_click", { ref: "@e2" })).toEqual(["click", "@e2"]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_snapshot", { interactive: true })).toEqual([
    "snapshot",
    "--interactive",
  ]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_scroll", { direction: "down", amount: 400 })).toEqual([
    "scroll",
    "down",
    "400",
  ]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_eval", { script: "1+1" })).toEqual(["eval", "1+1"]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_tab_list", {})).toEqual(["tab", "list"]);
});

test("resolveAgentBrowserTabSwitchArg maps to agent-browser tab syntax", () => {
  expect(resolveAgentBrowserTabSwitchArg({ tabId: "t1" })).toBe("t1");
  expect(resolveAgentBrowserTabSwitchArg({ label: "Example Domain" })).toBe("Example Domain");
  expect(resolveAgentBrowserTabSwitchArg({ index: 0 })).toBe("t1");
  expect(resolveAgentBrowserTabSwitchArg({ index: 1 })).toBe("t2");
  expect(mapAgentBrowserToolToCliArgs("agent_browser_tab_switch", { tabId: "t2" })).toEqual(["tab", "t2"]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_tab_switch", { index: 0 })).toEqual(["tab", "t1"]);
});


test("mapAgentBrowserToolToCliArgs screenshot always includes output path", () => {
  const args = mapAgentBrowserToolToCliArgs("agent_browser_screenshot", {});
  expect(args[0]).toBe("screenshot");
  expect(args[1]).toMatch(/eco-browser-screenshot-\d+\.png$/);
});

test("callAgentBrowserToolViaCli uses async spawn (does not block main process)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/main/agent-browser-cli-bridge.ts", import.meta.url)),
    "utf8",
  );
  expect(source).toContain("export async function callAgentBrowserToolViaCli");
  expect(source).toContain("spawn(");
  expect(source).not.toContain("spawnSync");
});

test("mapAgentBrowserToolToCliArgs forwards extraArgs", () => {
  expect(
    mapAgentBrowserToolToCliArgs("agent_browser_open", {
      url: "https://example.com",
      extraArgs: ["--json"],
    }),
  ).toEqual(["open", "https://example.com", "--json"]);
});
