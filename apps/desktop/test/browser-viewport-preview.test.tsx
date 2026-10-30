import { expect, test } from "bun:test";
import { createElement } from "react";
import { BrowserViewportControls } from "../src/renderer/BrowserViewportControls";
import { BrowserWebviewPersistentHost } from "../src/renderer/BrowserWebviewPersistentHost";
import { browserStateStore } from "../src/renderer/browser-state-store";
import {
  resetBrowserWebviewLayoutForTests,
  setBrowserWebviewViewportRect,
} from "../src/renderer/browser-webview-layout";
import type { BrowserViewState } from "../src/shared/browser";
import { BROWSER_AGENT_DEFAULT_VIEWPORT } from "../src/shared/browser-viewport";
import { renderLocalized } from "./i18n-test";

test("fixed Agent preview keeps its DOM dimensions when panels open, resize, split and hide", () => {
  const previous = browserStateStore.getState();
  const state: BrowserViewState = {
    uiScopeId: "preview-thread",
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
  const page = {
    id: "fixed-preview",
    threadId: "preview-thread",
    partition: "fixture",
    url: "https://fixture.test",
    title: "Fixture",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    focused: true,
    source: "agent" as const,
    createdAt: 1,
    viewport: { ...BROWSER_AGENT_DEFAULT_VIEWPORT },
  };
  browserStateStore.setState({ ...state, instances: [page], allInstances: [page] });
  try {
    const transforms = new Set<string>();
    for (const bounds of [
      null,
      { width: 600, height: 700 },
      { width: 1200, height: 900 },
      { width: 300, height: 700 },
      null,
    ]) {
      setBrowserWebviewViewportRect(
        page.id,
        bounds ? ({ ...bounds, left: 50, top: 100 } as DOMRectReadOnly) : null,
      );
      const markup = renderLocalized(
        createElement(BrowserWebviewPersistentHost, { browserId: page.id }),
        "zh-CN",
      );
      const host = markup.match(/data-browser-id="fixed-preview"[^>]+style="([^"]+)"/)?.[1];
      expect(host).toContain("width:1366px");
      expect(host).toContain("height:768px");
      expect(markup).toContain(`data-browser-host-hidden="${bounds ? "false" : "true"}"`);
      if (bounds) transforms.add(host?.match(/transform:scale\(([^)]+)\)/)?.[1] ?? "missing");
    }
    expect(transforms.size).toBe(3);
    expect(transforms.has("missing")).toBe(false);
  } finally {
    resetBrowserWebviewLayoutForTests();
    browserStateStore.setState(previous ?? state);
  }
});

test("fixed laptop and custom viewports are labeled accurately and can switch to Responsive", () => {
  for (const viewport of [
    BROWSER_AGENT_DEFAULT_VIEWPORT,
    { ...BROWSER_AGENT_DEFAULT_VIEWPORT, preset: "custom" as const, width: 1280 },
  ]) {
    const markup = renderLocalized(
      createElement(BrowserViewportControls, {
        browserId: "fixed-controls",
        viewport,
        onChange() {},
      }),
      "zh-CN",
    );
    expect(markup).toContain(
      `<option value="${viewport.preset}" selected="">${viewport.preset === "custom" ? "自定义" : "Laptop"}</option>`,
    );
    expect(markup).toContain('<option value="auto">自适应</option>');
  }
});
