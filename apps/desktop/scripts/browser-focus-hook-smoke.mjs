// Run through Electron. Test files/results stay outside the repository.
import { app, BrowserWindow } from "electron";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { focusHookBuildProfile } from "./browser-focus-hook-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "mori-browser-focus-hook-"));
mkdirSync(path.join(output, "profile"), { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.on("window-all-closed", () => {});
const require = createRequire(import.meta.url);
const koffi = require("koffi");
const profile = focusHookBuildProfile(process.platform, process.arch);
if (!profile) throw new Error(`Unsupported focus Hook smoke platform: ${process.platform}-${process.arch}`);
const library = koffi.load(path.join(root, "dist/native/browser-focus-hook", profile.target, profile.library));
const hook = Object.fromEntries(["install", "uninstall"].map(name => [name, library.func(`int mori_browser_focus_${name}()`)]));
hook.error = library.func("const char *mori_browser_focus_error()");
hook.depth = library.func("unsigned int mori_browser_focus_depth()");
hook.blocked = library.func("uint64_t mori_browser_focus_blocked()");
hook.allowed = library.func("uint64_t mori_browser_focus_allowed()");
const call = name => assert.equal(hook[name](), 0, `${name}: ${hook.error()}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { versions: process.versions, output, cases: [] };
let window, server;
const watchdog = setTimeout(() => {
  report.error = "Native focus smoke timed out";
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.error(`${report.error}: ${output}`);
  app.exit(1);
}, 60_000);

async function send(guest, input, agent = true) {
  const types = { mouseDown: "mousePressed", mouseUp: "mouseReleased", mouseMove: "mouseMoved" };
  const params = { type: types[input.type], x: input.x, y: input.y, button: input.type === "mouseMove" ? "none" : "left", clickCount: 1, buttons: input.type === "mouseDown" || input.modifiers?.includes("leftButtonDown") ? 1 : 0 };
  if (!agent) return guest.sendInputEvent(input); // Native non-debugger provenance.
  return guest.debugger.sendCommand("Input.dispatchMouseEvent", params);
}
async function click(guest, x = 30, y = 20, agent = true) {
  await send(guest, { type: "mouseDown", x, y, button: "left", clickCount: 1 }, agent);
  await send(guest, { type: "mouseUp", x, y, button: "left", clickCount: 1 }, agent);
}
async function focusComposer() {
  await window.webContents.executeJavaScript(`composer.focus();composer.value='human';composer.setSelectionRange(5,5);window.events=[];`);
}
async function hostState() {
  return window.webContents.executeJavaScript(`({active:document.activeElement.id,events,value:composer.value})`);
}
async function checkIsolated(name) {
  await delay(10);
  const state = await hostState();
  assert.equal(state.active, "composer", name);
  assert(!state.events.some(event => ["blur", "compositionend"].includes(event.type)), `${name}: ${JSON.stringify(state)}`);
  assert.equal(hook.depth(), 0);
  report.cases.push({ name, state });
}

async function main() {
try {
  console.log("[focus-smoke] ready; installing native Hook");
  call("install");
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/host") {
      res.end(`<textarea id=composer>human</textarea><webview id=page style="display:flex;width:800px;height:500px" src="http://127.0.0.1:${server.address().port}/page"></webview><script>window.events=[];for(const type of ['blur','input','compositionstart','compositionupdate','compositionend'])composer.addEventListener(type,e=>events.push({type,trusted:e.isTrusted,data:e.data}));</script>`);
    } else if (req.url === "/frame") {
      res.end(`<button style="position:absolute;left:0;top:0;width:150px;height:40px" onclick="parent.postMessage({frameClick:event.isTrusted},'*')">Frame button</button>`);
    } else {
      res.end(`<button id=target style="position:absolute;left:0;top:0;width:150px;height:40px" onclick="clicks++;trusted.push(event.isTrusted)">Click</button><input id=field style="position:absolute;left:170px;top:0"><div id=drag style="position:absolute;left:0;top:55px;width:180px;height:35px;background:gray">Drag target</div><iframe style="position:absolute;left:0;top:110px;width:300px;height:100px;border:0" src="http://localhost:${server.address().port}/frame"></iframe><script>window.clicks=0;window.trusted=[];window.framesClicked=[];window.dragEvents=[];addEventListener('message',e=>{if(e.data.frameClick!==undefined)framesClicked.push(e.data.frameClick)});for(const type of ['mousedown','mousemove','mouseup'])drag.addEventListener(type,e=>dragEvents.push({type,buttons:e.buttons,trusted:e.isTrusted}));</script>`);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  for (let cycle = 0; cycle < 5; cycle++) {
    console.log(`[focus-smoke] guest lifecycle ${cycle}`);
    window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { webviewTag: true } });
    const ready = new Promise((resolve, reject) => window.webContents.on("did-attach-webview", (_, guest) => {
      guest.once("did-finish-load", () => resolve(guest));
      guest.once("did-fail-load", (_, code, description) => reject(new Error(`Guest load failed: ${code} ${description}`)));
    }));
    await window.loadURL(`http://127.0.0.1:${server.address().port}/host`);
    const guest = await ready;
    window.webContents.debugger.attach("1.3");
    guest.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await guest.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    for (let i = 0; i < 50; i++) {
      await focusComposer();
      await click(guest);
      await checkIsolated(`click-${cycle}-${i}`);
    }
    assert.equal(await guest.executeJavaScript("clicks"), 50);
    assert(await guest.executeJavaScript("trusted.every(Boolean)"));

    await focusComposer();
    await guest.executeJavaScript("field.focus()");
    guest.sendInputEvent({ type: "char", keyCode: "Z" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "u" });
    await checkIsolated(`input-routing-${cycle}`);
    assert.equal((await hostState()).value, "humanu");
    assert.equal(await guest.executeJavaScript("field.value"), "Z");

    for (const modifiers of [[], ["shift"]]) {
      guest.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers });
      await checkIsolated(`keyboard-tab-${cycle}-${modifiers.length}`);
    }

    if (cycle === 0) {
      const secondReady = new Promise(resolve => window.webContents.once("did-attach-webview", (_, wc) => wc.once("did-finish-load", () => resolve(wc))));
      await window.webContents.executeJavaScript(`const second=document.createElement('webview');second.id='second';second.style='display:flex;width:600px;height:400px';second.src='http://127.0.0.1:${server.address().port}/page';document.body.append(second);void 0`);
      const second = await secondReady;
      second.debugger.attach("1.3");
      await second.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      await focusComposer();
      await Promise.all([guest, second].map(async (target, index) => {
        for (let i = 0; i < 25; i++) {
          await click(target);
          await checkIsolated(`concurrent-${index}-${i}`);
        }
      }));
      assert.equal(await second.executeJavaScript("clicks"), 25);
      assert.equal(await guest.executeJavaScript("clicks"), 75);
      await window.webContents.executeJavaScript("document.getElementById('second').remove()");
    }

    await focusComposer();
    await window.webContents.debugger.sendCommand("Input.imeSetComposition", { text: "未完成", selectionStart: 0, selectionEnd: 3 });
    await click(guest);
    await window.webContents.debugger.sendCommand("Input.imeSetComposition", { text: "未完成继续", selectionStart: 0, selectionEnd: 5 });
    await checkIsolated(`composition-${cycle}`);
    await window.webContents.debugger.sendCommand("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });

    await focusComposer();
    await click(guest, 30, 125);
    await checkIsolated(`cross-site-frame-${cycle}`);
    assert.deepEqual(await guest.executeJavaScript("framesClicked"), [true], "cross-site frame must receive the click");

    await focusComposer();
    await send(guest, { type: "mouseDown", x: 10, y: 65, button: "left", clickCount: 1 });
    await send(guest, { type: "mouseMove", x: 90, y: 65, modifiers: ["leftButtonDown"] });
    await send(guest, { type: "mouseUp", x: 90, y: 65, button: "left", clickCount: 1 });
    await checkIsolated(`drag-${cycle}`);
    const drag = await guest.executeJavaScript("dragEvents");
    assert(drag.some(e => e.type === "mousemove" && e.buttons === 1 && e.trusted));

    await focusComposer();
    await click(guest, 30, 20, false);
    await delay(20);
    assert.equal((await hostState()).active, "page", "unmarked input must focus normally");
    assert.equal(hook.depth(), 0);
    // Returning to normal behavior must also survive removal/reinstallation.
    call("uninstall");
    await focusComposer();
    await click(guest, 30, 20, false);
    await delay(20);
    assert.equal((await hostState()).active, "page");
    call("install");
    window.destroy();
    window = undefined;
  }
  report.blocked = String(hook.blocked());
  report.allowed = String(hook.allowed());
  report.ok = true;
  console.log(`PASS ${report.cases.length} native focus checks, 5 guest lifecycles, concurrent pages, Tab keys, cross-site iframe, pressed mouse movement, IME and input routing. ${output}`);
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  server?.close();
  if (hook.depth() === 0) call("uninstall");
  app.exit(report.ok ? 0 : 1);
}

}
void app.whenReady().then(main);
