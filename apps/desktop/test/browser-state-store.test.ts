import { expect, test } from "bun:test";
import { browserStateForScope, browserStateStore } from "../src/renderer/browser-state-store";
import type { BrowserViewState } from "../src/shared/browser";

function state(uiScopeId: string): BrowserViewState {
  return {
    uiScopeId,
    instances: [],
    allInstances: [],
    guestInstances: [],
    allGuestInstances: [],
    url: "about:blank",
    title: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    visible: false,
    agentIntegrationEnabled: true,
    agentBrowserAvailable: true,
  };
}

test("browser panels reject snapshots belonging to the previous conversation", () => {
  const previous = state("thread-a");
  expect(browserStateForScope(previous, "thread-b")).toBeUndefined();
  expect(browserStateForScope(previous, "thread-a")).toBe(previous);
});

test("a delayed browser hydration cannot replace a newer scope-switch broadcast", async () => {
  const previousWindow = globalThis.window;
  let resolveRead!: (value: BrowserViewState) => void;
  let broadcast!: (value: BrowserViewState) => void;
  const pendingRead = new Promise<BrowserViewState>((resolve) => {
    resolveRead = resolve;
  });
  browserStateStore.disposeSourceForTests();
  globalThis.window = {
    eco: {
      getBrowserState: () => pendingRead,
      onBrowserStateChanged: (listener: typeof broadcast) => {
        broadcast = listener;
        return () => {};
      },
    },
  } as unknown as Window & typeof globalThis;
  try {
    const hydration = browserStateStore.hydrate();
    const latest = state("thread-b");
    broadcast(latest);
    resolveRead(state("thread-a"));
    await hydration;
    expect(browserStateStore.getState()).toBe(latest);
  } finally {
    browserStateStore.disposeSourceForTests();
    globalThis.window = previousWindow;
  }
});
