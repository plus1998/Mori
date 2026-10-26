import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerBrowserWebviewHostSlot,
  resetBrowserWebviewLayoutForTests,
  resolveBrowserWebviewHostSlot,
} from "../src/renderer/browser-webview-layout";
import { BrowserWebviewPool, browserWebviewPool } from "../src/renderer/browser-webview-pool";
import { createMockHostSlot, withBrowserWebviewTestDom } from "./browser-webview-test-dom";

const browserHostSource = readFileSync(
  fileURLToPath(new URL("../src/main/browser-host.ts", import.meta.url)),
  "utf8",
);
const browserPanelSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/BrowserPanel.tsx", import.meta.url)),
  "utf8",
);
const subagentTaskDrawerSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/SubagentTaskDrawer.tsx", import.meta.url)),
  "utf8",
);
const browserWebviewPoolSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/browser-webview-pool.ts", import.meta.url)),
  "utf8",
);
const browserWebviewLayerSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/BrowserWebviewLayer.tsx", import.meta.url)),
  "utf8",
);
const browserWebviewPersistentHostSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/BrowserWebviewPersistentHost.tsx", import.meta.url)),
  "utf8",
);
const browserWebviewLayoutSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/browser-webview-layout.ts", import.meta.url)),
  "utf8",
);
const browserStateStoreSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/browser-state-store.ts", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(fileURLToPath(new URL("../src/renderer/App.tsx", import.meta.url)), "utf8");
const taskPanelResizeSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/task-panel-resize-session.ts", import.meta.url)),
  "utf8",
);
const lazyAppPanelsSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/lazy-app-panels.tsx", import.meta.url)),
  "utf8",
);
const stylesSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/styles.css", import.meta.url)),
  "utf8",
);
const mainSource = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");

test("browser host uses renderer webview guests instead of WebContentsView", () => {
  expect(browserHostSource).not.toContain("WebContentsView");
  expect(browserHostSource).toContain("registerGuestWebContents");
  expect(browserHostSource).toContain("waitForGuestWebContents");
  expect(browserHostSource).toContain("allGuestInstances");
});

test("main window enables webviewTag and installs guest bridge", () => {
  expect(mainSource).toContain("webviewTag: true");
  expect(mainSource).toContain("installBrowserGuestBridge");
  expect(mainSource).toContain("browserRegisterGuest");
  expect(mainSource).not.toContain("browserSetBounds");
});

test("browser webview z-index stays above fullscreen task panel shell", () => {
  expect(browserWebviewLayoutSource).toContain("BROWSER_WEBVIEW_VISIBLE_Z_INDEX = 91");
  expect(browserWebviewPersistentHostSource).toContain("BROWSER_WEBVIEW_VISIBLE_Z_INDEX");
  expect(stylesSource).toMatch(
    /\.codex-main-pane\.is-task-panel-fullscreen[\s\S]*?\.workspace-panel\.is-task-panel-mode[\s\S]*?z-index:\s*90/,
  );
});

test("browser guest load failures are shown above the guest with a retry action", () => {
  expect(browserHostSource).toContain('wc.on("did-fail-load"');
  expect(browserHostSource).toContain("loadError");
  expect(browserWebviewPersistentHostSource).toContain("browser-page-status");
  expect(browserWebviewPersistentHostSource).toContain("data-browser-empty");
  expect(browserWebviewPersistentHostSource).toContain("browserReload");
  expect(browserPanelSource).toContain("browser.toolsTitle");
  expect(subagentTaskDrawerSource).toContain("browser.newTab");
  expect(subagentTaskDrawerSource).toContain("onClick={onNewBrowserTab}");
  expect(subagentTaskDrawerSource).not.toContain("task-panel-home-title");
  expect(appSource).toContain("onNewBrowserTab={openBrowserTaskPanel}");
  expect(appSource).toContain("openBrowserTaskPanel();");
  expect(stylesSource).toContain(".browser-page-status");
});

test("browser navigation keeps the current guest painted until the next page commits", () => {
  expect(browserWebviewPersistentHostSource).not.toContain('data-browser-loading="true"');
  expect(stylesSource).not.toContain('.browser-webview-host-slot[data-browser-loading="true"]');
  expect(stylesSource).toContain('.browser-webview-host-slot[data-browser-status="true"]');
});

test("browser layer uses imperative pool driven by allGuestInstances", () => {
  expect(browserPanelSource).toContain("BrowserWebviewViewportMarker");
  expect(browserPanelSource).not.toContain("registerBrowserWebviewHost");
  expect(browserStateStoreSource).toContain("allGuestInstances");
  expect(browserStateStoreSource).toContain("state?.allGuestInstances?.map");
  expect(browserWebviewLayerSource).toContain("browserWebviewPool.sync");
  expect(browserWebviewLayerSource).not.toContain("useLayoutEffect");
  expect(browserWebviewLayerSource).toContain("BrowserWebviewPersistentHost");
  expect(browserWebviewLayerSource).not.toContain("BrowserWebviewGuest");
  expect(browserWebviewLayerSource).not.toContain("browser-webview-park");
  // The layer is mounted by App through the lazy wrapper that resolves to it: the renderer
  // defers the panel chunk, and the mount point is what this assertion is about.
  expect(appSource).toContain("<LazyBrowserWebviewLayer");
  expect(lazyAppPanelsSource).toContain('import("./BrowserWebviewLayer")');
  expect(lazyAppPanelsSource).toContain("m.BrowserWebviewLayer");
});

test("webview pool is the sole DOM owner — no React lifecycle destroy", () => {
  expect(browserWebviewPoolSource).toContain("class BrowserWebviewPool");
  expect(browserWebviewPoolSource).toContain("sync(desired");
  expect(browserWebviewPoolSource).toContain("intentionalRelease");
  expect(browserWebviewPoolSource).not.toContain("createPortal");
  expect(browserWebviewLayoutSource).not.toContain("park");
  expect(browserWebviewLayoutSource).not.toContain("resolveBrowserWebviewMountSlotKey");
});

test("browser webview pool sync creates, attaches, and releases guests", () => {
  withBrowserWebviewTestDom(() => {
    browserWebviewPool.resetForTests();
    resetBrowserWebviewLayoutForTests();

    const slot = createMockHostSlot();
    registerBrowserWebviewHostSlot("browser-1", slot);

    browserWebviewPool.sync([{ id: "browser-1", partition: "persist:eco-browser:test" }]);
    expect(browserWebviewPool.has("browser-1")).toBe(true);
    const webview = browserWebviewPool.getWebviewForTests("browser-1");
    expect(webview).toBeDefined();
    expect(webview?.parentElement).toBe(slot);
    expect(webview?.partition).toBe("persist:eco-browser:test");

    browserWebviewPool.sync([{ id: "browser-1", partition: "persist:eco-browser:test" }]);
    expect(browserWebviewPool.getWebviewForTests("browser-1")).toBe(webview);

    browserWebviewPool.sync([]);
    expect(browserWebviewPool.has("browser-1")).toBe(false);
    expect(slot.querySelector("webview")).toBeNull();

    browserWebviewPool.resetForTests();
    resetBrowserWebviewLayoutForTests();
  });
});

test("task panel resize blocks browser webview pointer capture", () => {
  expect(browserWebviewLayoutSource).toContain("BROWSER_WEBVIEW_RESIZE_SHIELD_Z_INDEX");
  expect(stylesSource).toContain("body.is-resizing-task-panel::before");
  expect(stylesSource).toContain("body.is-resizing-task-panel .browser-panel-webview");
  expect(stylesSource).toMatch(/body\.is-resizing-task-panel::before[\s\S]*?z-index:\s*92/);
  expect(appSource).toContain("handleTaskPanelResizePointerDown");
  expect(appSource).toContain("startTaskPanelResizeSession");
  expect(taskPanelResizeSource).toContain("setPointerCapture");
});

test("browser webview pool attaches when host slot registers after ensure", () => {
  withBrowserWebviewTestDom(() => {
    const pool = new BrowserWebviewPool();
    pool.resetForTests();
    resetBrowserWebviewLayoutForTests();

    pool.sync([{ id: "browser-2", partition: "persist:eco-browser:late" }]);
    expect(pool.has("browser-2")).toBe(true);
    expect(pool.getWebviewForTests("browser-2")?.parentElement).toBeNull();

    const slot = createMockHostSlot();
    registerBrowserWebviewHostSlot("browser-2", slot);
    pool.attach("browser-2");
    expect(pool.getWebviewForTests("browser-2")?.parentElement).toBe(slot);
    expect(resolveBrowserWebviewHostSlot("browser-2")).toBe(slot);

    pool.resetForTests();
    resetBrowserWebviewLayoutForTests();
  });
});
