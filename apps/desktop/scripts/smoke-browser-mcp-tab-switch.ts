/**
 * Real Electron guests + BrowserHost + HTTP MCP + bundled agent-browser.
 * bun build scripts/smoke-browser-mcp-tab-switch.ts --target=node --external electron --outfile .tmp/browser-mcp-tab-switch.mjs
 * node_modules/.bin/electron .tmp/browser-mcp-tab-switch.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/main/browser-host";
import type { AgentBrowserMcpToolResult } from "../src/main/agent-browser-cli-bridge";

// macOS Unix socket paths are capped at 103 bytes, including the session suffix.
const root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "eco-tabs-"));
process.env.AGENT_BROWSER_SOCKET_DIR = path.join(root, "sockets");
fs.mkdirSync(path.join(root, "profile"), { recursive: true });
app.setPath("userData", path.join(root, "profile"));
const threadId = `thr_tab_switch_${Date.now()}`;

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
      `<title>${req.url}</title><h1>${req.url}</h1><button onclick="document.body.dataset.clicked='yes'">Click me</button>`,
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
    const a = await open(`http://127.0.0.1:${port}/admin`);
    await open(`http://127.0.0.1:${port}/same`);
    const c = await open(`http://127.0.0.1:${port}/same`);
    await c.guest.executeJavaScript(
      "document.querySelector('h1').textContent='Third tab'; window.tabMarker='C'",
    );
    await call("tab_switch", { tabId: "t1" });
    assert.match(await call("eval", { script: "location.href" }), /\/admin/);
    await call("tab_switch", { tabId: "t3" });
    assert.equal(host.getState().focusedBrowserId, c.id);
    assert.match(await call("eval", { script: "window.tabMarker" }), /"C"/);
    const snapshot = await call("snapshot");
    assert.match(snapshot, /Third tab/);
    const ref = snapshot.match(/button "Click me" \[ref=(\w+)\]/)?.[1];
    assert.ok(ref, snapshot);
    await call("click", { ref: `@${ref}` });
    assert.match(await call("eval", { script: "document.body.dataset.clicked" }), /"yes"/);
    console.log("PASS: t1 → t3, same-URL pages, eval/snapshot/click target the third guest");

    host.closeBrowser(a.id);
    await call("tab_switch", { tabId: "t1" }); // formerly t2
    assert.match(await call("snapshot"), /heading "\/same"/);
    await call("tab_switch", { tabId: "t2" }); // formerly t3
    assert.match(await call("eval", { script: "window.tabMarker" }), /"C"/);
    await call("tab_close");
    assert.match(await call("eval", { script: "location.href" }), /\/same/);
    assert.doesNotMatch(await call("snapshot"), /Third tab/);
    console.log("PASS: closing earlier/current tabs preserves the correct Eco target mapping");
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
