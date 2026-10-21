/**
 * Real Electron guests + BrowserHost + HTTP MCP + bundled agent-browser.
 * bun build scripts/smoke-browser-viewport.ts --target=node --external electron --outfile .tmp/browser-viewport-smoke.mjs
 * node_modules/.bin/electron .tmp/browser-viewport-smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import type { AgentBrowserMcpToolResult } from "../src/main/agent-browser-cli-bridge";
import { BrowserHost } from "../src/main/browser-host";

// macOS Unix socket paths are capped at 103 bytes, including the session suffix.
const root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "eco-viewport-"));
process.env.AGENT_BROWSER_SOCKET_DIR = path.join(root, "sockets");
fs.mkdirSync(path.join(root, "profile"), { recursive: true });
app.setPath("userData", path.join(root, "profile"));
const threadId = `thr_viewport_${Date.now()}`;

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: true,
    width: 900,
    height: 700,
    webPreferences: { webviewTag: true, backgroundThrottling: false },
  });
  await win.loadURL("data:text/html,<html><body></body></html>");
  const host = new BrowserHost({
    getMainWindow: () => win,
    getSettings: () =>
      ({ get: () => ({ agentIntegrationEnabled: true, openApprovalMode: "always_allow" }) }) as never,
    broadcast: () => {},
    resolveWorkspacePath: () => root,
  });
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${req.url}</title><h1>${req.url}</h1><input><button onclick="document.body.dataset.clicked='yes'">Click me</button>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const injection = await host.resolveAgentBrowserMcpInjection({ threadId, sessionEnabled: true });
  assert.equal(injection.enabled, true, JSON.stringify(injection));
  const sdk = injection.sdkEntry as { url: string; headers: Record<string, string> };
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await fetch(sdk.url.replace(/\/mcp$/, "/v1/tools/call"), {
      method: "POST",
      headers: { ...sdk.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `agent_browser_${name}`, arguments: args }),
    });
    const body = (await response.json()) as { result?: AgentBrowserMcpToolResult; error?: string };
    assert.equal(response.ok, true, JSON.stringify(body));
    assert.ok(body.result && !body.result.isError, JSON.stringify(body));
    return body.result.content.map((c) => c.text).join("\n");
  }
  async function open(url: string) {
    const state = await host.openSharedSession({ threadId, url, newBrowser: true, revealUi: false });
    const id = state.focusedBrowserId;
    assert.ok(id);
    const instance = state.guestInstances.find((g) => g.id === id);
    assert.ok(instance);
    const attached = new Promise<import("electron").WebContents>((resolve) => {
      win.webContents.once("did-attach-webview", (_event, guest) => resolve(guest));
    });
    await win.webContents.executeJavaScript(`{
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(instance.partition)});
      view.style.cssText = 'position:absolute;inset:0;width:800px;height:600px';
      view.src = 'about:blank';
      document.body.append(view);
    }`);
    const guest = await attached;
    host.registerGuestWebContents(id, guest);
    const deadline = Date.now() + 10_000;
    while (guest.getURL() !== url || guest.isLoading()) {
      assert.ok(Date.now() < deadline, `guest failed to load ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { id, guest };
  }
  try {
    const deviceList = JSON.parse(await call("list_devices")).devices;
    assert.ok(deviceList.some((device: { preset: string }) => device.preset === "iphone-se"));
    assert.ok(deviceList.some((device: { preset: string }) => device.preset === "iphone-16"));
    const first = await open(`http://127.0.0.1:${port}/responsive`);
    const se = JSON.parse(await call("set_viewport", { preset: "iphone-se" }));
    assert.equal(se.metrics.width, 375);
    assert.equal(se.metrics.height, 667);
    assert.equal(se.metrics.deviceScaleFactor, 2);
    const iphone16 = JSON.parse(await call("set_viewport", { preset: "iphone-16" }));
    assert.equal(iphone16.metrics.width, 393);
    assert.equal(iphone16.metrics.height, 852);
    assert.equal(iphone16.metrics.deviceScaleFactor, 3);

    await first.guest.executeJavaScript("document.querySelector('input').value='retained'; window.marker=42");
    let applied = JSON.parse(await call("set_viewport", { preset: "phone" }));
    assert.equal(applied.metrics.width, 390);
    assert.equal(applied.metrics.height, 844);
    assert.equal(applied.metrics.deviceScaleFactor, 3);
    assert.equal(applied.metrics.touchPoints, 5);
    assert.equal(await first.guest.executeJavaScript("matchMedia('(max-width: 600px)').matches"), true);
    const screenshotPath = path.join(root, "phone.png");
    await call("screenshot", { path: screenshotPath });
    const png = fs.readFileSync(screenshotPath);
    assert.equal(png.readUInt32BE(16), 1170);
    assert.equal(png.readUInt32BE(20), 2532);
    const snapshot = await call("snapshot");
    const ref = snapshot.match(/button "Click me" \[ref=(\w+)\]/)?.[1];
    assert.ok(ref, snapshot);
    await call("click", { ref: `@${ref}` });
    assert.equal(await first.guest.executeJavaScript("document.body.dataset.clicked"), "yes");
    applied = JSON.parse(await call("set_viewport", { preset: "tablet", landscape: true }));
    assert.equal(applied.metrics.width, 1180);
    assert.equal(applied.metrics.height, 820);
    assert.equal(applied.metrics.orientation, "landscape-primary");
    applied = JSON.parse(await call("set_viewport", { preset: "desktop" }));
    assert.equal(applied.metrics.width, 1920);
    assert.equal(applied.metrics.touchPoints, 0);
    await win.webContents.executeJavaScript(`{
      const view = document.querySelector('webview');
      view.style.cssText = 'position:absolute;left:20px;top:20px;width:1920px;height:1080px;transform:scale(0.3);transform-origin:top left';
    }`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    applied = JSON.parse(await call("get_viewport"));

    assert.equal(applied.metrics.width, 1920);
    assert.equal(applied.metrics.deviceScaleFactor, 1);
    await call("screenshot", { path: screenshotPath });
    const scaledPng = fs.readFileSync(screenshotPath);
    assert.equal(scaledPng.readUInt32BE(16), 1920);
    assert.equal(scaledPng.readUInt32BE(20), 1080);
    await first.guest.executeJavaScript("document.body.dataset.clicked=''");
    const scaledSnapshot = await call("snapshot");
    const scaledRef = scaledSnapshot.match(/button "Click me" \[ref=(\w+)\]/)?.[1];
    assert.ok(scaledRef, scaledSnapshot);
    await call("click", { ref: `@${scaledRef}` });
    assert.equal(await first.guest.executeJavaScript("document.body.dataset.clicked"), "yes");

    assert.equal(await first.guest.executeJavaScript("document.querySelector('input').value"), "retained");
    assert.equal(await first.guest.executeJavaScript("window.marker"), 42);
    first.guest.reload();
    const deadline = Date.now() + 10_000;
    while (first.guest.isLoading()) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    applied = JSON.parse(await call("get_viewport"));
    assert.equal(applied.metrics.width, 1920);
    await open(`http://127.0.0.1:${port}/other`);
    applied = JSON.parse(await call("get_viewport"));
    assert.equal(applied.viewport, null);
    await call("tab_switch", { tabId: "t1" });
    applied = JSON.parse(await call("get_viewport"));
    assert.equal(applied.metrics.width, 1920);
    await win.webContents.executeJavaScript(
      "document.querySelector('webview').style.cssText='position:absolute;width:800px;height:600px'",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    applied = JSON.parse(await call("set_viewport", { preset: "auto" }));
    assert.equal(applied.viewport, null);
    assert.equal(applied.metrics.width, 800);
    console.log(
      "PASS: real MCP device sizes, DPR, mobile breakpoint, screenshot pixels, snapshot/click, orientation, retained state, navigation, tab isolation, auto reset",
    );
  } finally {
    try {
      await call("close");
    } finally {
      host.dispose();
      win.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

main()
  .then(() => {
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(1);
  });
