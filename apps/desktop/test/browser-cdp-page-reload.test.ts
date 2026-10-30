import { expect, test } from "bun:test";
import { mapAgentBrowserToolToCliArgs } from "../src/main/agent-browser-cli-bridge";
import { AGENT_BROWSER_CORE_TOOL_NAMES } from "../src/main/agent-browser-core-tools";
import {
  applyGuestPageBringToFront,
  applyGuestPageNavigate,
  applyGuestPageNavigateToHistoryEntry,
  applyGuestPageReload,
  assertBrowserGuestWebContents,
  inputTypeSupportsSelection,
  isBrowserGuestWebContents,
  mapCdpMouseEventToSendInput,
} from "../src/main/browser-cdp-proxy";

function guestWc(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    getType: () => "webview" as const,
    id: 42,
    ...overrides,
  };
}

test("inputTypeSupportsSelection excludes email/number/time", () => {
  expect(inputTypeSupportsSelection("text")).toBe(true);
  expect(inputTypeSupportsSelection("tel")).toBe(true);
  expect(inputTypeSupportsSelection("email")).toBe(false);
  expect(inputTypeSupportsSelection("number")).toBe(false);
  expect(inputTypeSupportsSelection("time")).toBe(false);
  expect(inputTypeSupportsSelection("date")).toBe(false);
});

test("isBrowserGuestWebContents only accepts webview", () => {
  expect(isBrowserGuestWebContents(guestWc())).toBe(true);
  expect(isBrowserGuestWebContents(guestWc({ getType: () => "window" }))).toBe(false);
  expect(isBrowserGuestWebContents(guestWc({ isDestroyed: () => true }))).toBe(false);
});

test("assertBrowserGuestWebContents rejects main window type", () => {
  expect(() => assertBrowserGuestWebContents(guestWc({ getType: () => "window" }))).toThrow(
    /non-guest webContents/,
  );
});

test("Page.reload uses webContents.reload (not raw CDP)", () => {
  const calls: string[] = [];
  const wc = guestWc({
    reload: () => {
      calls.push("reload");
    },
    reloadIgnoringCache: () => {
      calls.push("reloadIgnoringCache");
    },
  });

  expect(applyGuestPageReload(wc)).toEqual({});
  expect(calls).toEqual(["reload"]);
});

test("Page.reload with ignoreCache uses reloadIgnoringCache", () => {
  const calls: string[] = [];
  const wc = guestWc({
    reload: () => {
      calls.push("reload");
    },
    reloadIgnoringCache: () => {
      calls.push("reloadIgnoringCache");
    },
  });

  expect(applyGuestPageReload(wc, { ignoreCache: true })).toEqual({});
  expect(calls).toEqual(["reloadIgnoringCache"]);
});

test("Page.reload rejects main window webContents", () => {
  const wc = guestWc({
    getType: () => "window",
    reload: () => {
      throw new Error("should not reload");
    },
    reloadIgnoringCache: () => {
      throw new Error("should not reloadIgnoringCache");
    },
  });

  expect(() => applyGuestPageReload(wc)).toThrow(/non-guest webContents/);
});

test("Page.navigate uses loadURL on guest only", async () => {
  const urls: string[] = [];
  const wc = guestWc({
    loadURL: async (url: string) => {
      urls.push(url);
    },
  });

  expect(await applyGuestPageNavigate(wc, { url: "https://example.com/" })).toEqual({});
  expect(urls).toEqual(["https://example.com/"]);
});

test("Page.navigate rejects main window", async () => {
  const wc = guestWc({
    getType: () => "window",
    loadURL: async () => {
      throw new Error("should not load");
    },
  });
  await expect(applyGuestPageNavigate(wc, { url: "https://example.com/" })).rejects.toThrow(
    /non-guest webContents/,
  );
});

test("Page.navigateToHistoryEntry uses goToIndex", () => {
  const indexes: number[] = [];
  const wc = guestWc({
    navigationHistory: {
      goToIndex: (index: number) => {
        indexes.push(index);
      },
    },
  });
  expect(applyGuestPageNavigateToHistoryEntry(wc, { entryId: 2 })).toEqual({});
  expect(indexes).toEqual([2]);
});

test("Page.bringToFront keeps the human's native keyboard focus", () => {
  let focused = false;
  const wc = guestWc({
    focus: () => {
      focused = true;
    },
  });
  expect(applyGuestPageBringToFront(wc)).toEqual({});
  expect(focused).toBe(false);
});

test("mapCdpMouseEventToSendInput maps pressed/moved/wheel", () => {
  expect(mapCdpMouseEventToSendInput({ type: "mousePressed", x: 10, y: 20, button: "left" })).toEqual({
    type: "mouseDown",
    x: 10,
    y: 20,
    button: "left",
    clickCount: 1,
  });
  expect(mapCdpMouseEventToSendInput({ type: "mouseMoved", x: 1, y: 2 })).toEqual({
    type: "mouseMove",
    x: 1,
    y: 2,
  });
  expect(mapCdpMouseEventToSendInput({ type: "mouseWheel", x: 0, y: 0, deltaY: -100 })).toEqual({
    type: "mouseWheel",
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: -100,
  });
});

test("agent_browser_get_text is in core catalog and CLI map", () => {
  expect(AGENT_BROWSER_CORE_TOOL_NAMES).toContain("agent_browser_get_text");
  expect(mapAgentBrowserToolToCliArgs("agent_browser_get_text", { ref: "@e1" })).toEqual([
    "get",
    "text",
    "@e1",
  ]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_get_text", {})).toEqual(["get", "text"]);
});

test("browser wait mappings use agent-browser explicit modes", () => {
  expect(mapAgentBrowserToolToCliArgs("agent_browser_wait_for_text", { text: "Ready" })).toEqual([
    "wait",
    "--text",
    "Ready",
  ]);
  expect(mapAgentBrowserToolToCliArgs("agent_browser_wait_for_load", {})).toEqual([
    "wait",
    "--load",
    "load",
  ]);
});
