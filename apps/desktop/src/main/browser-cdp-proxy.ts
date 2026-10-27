import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { WebContents } from "electron";
import { FORBIDDEN_CDP_PORT } from "../shared/dev-cdp";
import {
  isBrowserAgentPresenceCdpMethod,
  parseBrowserAgentPresenceMouse,
} from "../shared/browser-agent-presence";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export { FORBIDDEN_CDP_PORT };

type GuestSendInputEvent = Parameters<WebContents["sendInputEvent"]>[0];

/** True only for Electron `<webview>` guests — never the Eco main BrowserWindow. */
export function isBrowserGuestWebContents(
  webContents: Pick<WebContents, "isDestroyed" | "getType">,
): boolean {
  if (webContents.isDestroyed()) {
    return false;
  }
  return webContents.getType() === "webview";
}

/**
 * Hard isolation: browser CDP / automation must never drive the Eco main window.
 * Only `<webview>` guest WebContents are allowed.
 */
export function assertBrowserGuestWebContents(
  webContents: Pick<WebContents, "isDestroyed" | "getType">,
): void {
  if (webContents.isDestroyed()) {
    throw new Error("Guest webContents destroyed");
  }
  const type = webContents.getType();
  if (type !== "webview") {
    throw new Error(
      `Refusing CDP on non-guest webContents (type=${type}); Mori main window must not handle browser automation`,
    );
  }
}

export interface BrowserCdpProxy {
  port: number;
  close: () => Promise<void>;
  /**
   * Broadcast Target.targetDestroyed / detatched to connected CDP clients.
   * Required when Eco UI closes a page outside of Target.closeTarget.
   */
  notifyTargetDestroyed: (targetId: string) => void;
  /** Eco-minted page (window.open / open new origin) outside Target.createTarget. */
  notifyTargetCreated: (targetId: string) => void;
  /** Keep agent-browser tab_list URLs/titles in sync after navigations. */
  notifyTargetInfoChanged: (targetId: string) => void;
}

export interface BrowserCdpTarget {
  /** Stable Eco browser id (used as CDP targetId + sessionId). */
  id: string;
  webContents: WebContents;
}

export interface MultiBrowserCdpProxyOptions {
  getTargets: () => BrowserCdpTarget[];
  /** When set, bind this port first; fall back to ephemeral on EADDRINUSE. */
  preferredPort?: number;
  onCreateTarget?: (url?: string) => BrowserCdpTarget | Promise<BrowserCdpTarget>;
  onActivateTarget?: (targetId: string) => void;
  onCloseTarget?: (targetId: string) => void | Promise<void>;
  onClientActivity?: (detail: {
    kind: "ws-connect" | "cdp-method";
    method?: string;
    targetId?: string;
    url?: string;
    /** Present for Input.dispatchMouseEvent when x/y parse. */
    mouse?: { x: number; y: number; type: string; buttons?: number };
  }) => void;
  /** Blur embedder / move OS keyboard focus before guest synthetic input. */
  onPrepareGuestKeyboardInput?: (target: BrowserCdpTarget) => void | Promise<void>;
  /**
   * Extra deny-list (e.g. main BrowserWindow webContents). Applied in addition to
   * {@link assertBrowserGuestWebContents}.
   */
  isForbiddenWebContents?: (webContents: WebContents) => boolean;
}

interface DebuggerLike {
  isAttached: () => boolean;
  attach: (protocolVersion?: string) => void;
  detach: () => void;
  sendCommand: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>;
  on: (event: "message", listener: (event: unknown, method: string, params: unknown) => void) => void;
  off: (event: "message", listener: (event: unknown, method: string, params: unknown) => void) => void;
}

function getDebugger(webContents: WebContents): DebuggerLike {
  return webContents.debugger as unknown as DebuggerLike;
}

function ensureDebuggerAttached(wc: WebContents): DebuggerLike {
  assertBrowserGuestWebContents(wc);
  const dbg = getDebugger(wc);
  if (!dbg.isAttached()) {
    dbg.attach("1.3");
  }
  return dbg;
}

function liveGuestTargets(
  options: MultiBrowserCdpProxyOptions,
): BrowserCdpTarget[] {
  return options.getTargets().filter((t) => {
    if (!t.webContents || t.webContents.isDestroyed()) {
      return false;
    }
    if (!isBrowserGuestWebContents(t.webContents)) {
      return false;
    }
    if (options.isForbiddenWebContents?.(t.webContents)) {
      return false;
    }
    return true;
  });
}

function assertTargetAllowed(options: MultiBrowserCdpProxyOptions, target: BrowserCdpTarget): void {
  assertBrowserGuestWebContents(target.webContents);
  if (options.isForbiddenWebContents?.(target.webContents)) {
    throw new Error(
      `Refusing CDP on forbidden webContents (id=${target.webContents.id}); Mori main window must not handle browser automation`,
    );
  }
}

function readFrames(buffer: Buffer, onFrame: (payload: Buffer, opcode: number) => void): Buffer {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset]!;
    const b1 = buffer[offset + 1]!;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      if (high !== 0) {
        throw new Error("CDP WebSocket frame too large");
      }
      payloadLen = low;
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + payloadLen;
    if (buffer.length - offset < total) break;
    let payload = buffer.subarray(offset + headerLen + maskLen, offset + total);
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const decoded = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        decoded[i] = payload[i]! ^ mask[i % 4]!;
      }
      payload = decoded;
    }
    onFrame(payload, opcode);
    offset += total;
  }
  return buffer.subarray(offset);
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  if (len < 126) {
    const frame = Buffer.alloc(2 + len);
    frame[0] = 0x81;
    frame[1] = len;
    payload.copy(frame, 2);
    return frame;
  }
  if (len < 65536) {
    const frame = Buffer.alloc(4 + len);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    payload.copy(frame, 4);
    return frame;
  }
  const frame = Buffer.alloc(10 + len);
  frame[0] = 0x81;
  frame[1] = 127;
  frame.writeUInt32BE(0, 2);
  frame.writeUInt32BE(len, 6);
  payload.copy(frame, 10);
  return frame;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeJsonFrame(socket: Socket, body: Record<string, unknown>): void {
  if (socket.destroyed) {
    return;
  }
  socket.write(encodeTextFrame(JSON.stringify(body)));
}

function broadcastJsonFrame(
  clients: Map<Socket, string | undefined>,
  body: Record<string, unknown>,
  targetId: string,
): void {
  const frame = encodeTextFrame(JSON.stringify(body));
  for (const [client, boundTargetId] of clients) {
    if (!client.destroyed && (!boundTargetId || boundTargetId === targetId)) {
      client.write(frame);
    }
  }
}

function pageTargetInfo(target: BrowserCdpTarget): Record<string, unknown> {
  const wc = target.webContents;
  const alive = wc && !wc.isDestroyed();
  return {
    targetId: target.id,
    type: "page",
    title: alive ? wc.getTitle() || "Mori Browser" : "Mori Browser",
    url: alive ? wc.getURL() || "about:blank" : "about:blank",
    attached: true,
    canAccessOpener: false,
  };
}

function listJsonPages(targets: BrowserCdpTarget[], port: number): unknown[] {
  return targets.map((target) => {
    const info = pageTargetInfo(target);
    const alive = target.webContents && !target.webContents.isDestroyed();
    return {
      description: "",
      devtoolsFrontendUrl: "",
      id: target.id,
      title: info.title,
      type: "page",
      url: info.url,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
      ...(alive
        ? {}
        : {
            /* keep keys stable */
          }),
    };
  });
}

/**
 * Session-scoped multi-page CDP proxy over multiple Electron webContents.debugger instances.
 * Binds 127.0.0.1 with an ephemeral port (never 9222). Only exposes targets from `getTargets`.
 */
export async function startMultiBrowserCdpProxy(
  options: MultiBrowserCdpProxyOptions,
): Promise<BrowserCdpProxy> {
  const clients = new Map<Socket, string | undefined>();
  const debuggerListeners = new Map<
    string,
    { wc: WebContents; listener: (event: unknown, method: string, params: unknown) => void }
  >();

  const syncDebuggerListeners = () => {
    const targets = liveGuestTargets(options);
    const liveIds = new Set(targets.map((t) => t.id));
    for (const [id, entry] of debuggerListeners) {
      if (!liveIds.has(id)) {
        try {
          const dbg = getDebugger(entry.wc);
          dbg.off("message", entry.listener);
        } catch {
          // ignore
        }
        debuggerListeners.delete(id);
      }
    }
    for (const target of targets) {
      if (debuggerListeners.has(target.id)) {
        continue;
      }
      try {
        assertTargetAllowed(options, target);
        const dbg = ensureDebuggerAttached(target.webContents);
        const listener = (_event: unknown, method: string, params: unknown) => {
          const message = JSON.stringify({
            method,
            params,
            sessionId: target.id,
          });
          const frame = encodeTextFrame(message);
          for (const [client, boundTargetId] of clients) {
            if (!client.destroyed && (!boundTargetId || boundTargetId === target.id)) {
              client.write(frame);
            }
          }
        };
        dbg.on("message", listener);
        debuggerListeners.set(target.id, { wc: target.webContents, listener });
      } catch (error) {
        process.stderr.write(
          `[eco-browser-cdp] attach debugger failed for ${target.id}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
  };

  // Initial attach for existing targets.
  syncDebuggerListeners();

  const notifyTargetDestroyed = (targetId: string) => {
    const id = targetId.trim();
    if (!id) {
      return;
    }
    broadcastJsonFrame(
      clients,
      {
        method: "Target.targetDestroyed",
        params: { targetId: id },
      },
      id,
    );
    // Drop session-scoped attaches keyed by our target id.
    broadcastJsonFrame(
      clients,
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: id, targetId: id },
      },
      id,
    );
    syncDebuggerListeners();
  };

  const notifyTargetCreated = (targetId: string) => {
    const id = targetId.trim();
    if (!id) {
      return;
    }
    const target = liveGuestTargets(options).find((t) => t.id === id);
    if (!target) {
      return;
    }
    syncDebuggerListeners();
    broadcastJsonFrame(
      clients,
      {
        method: "Target.targetCreated",
        params: { targetInfo: pageTargetInfo(target) },
      },
      id,
    );
  };

  const notifyTargetInfoChanged = (targetId: string) => {
    const id = targetId.trim();
    if (!id) {
      return;
    }
    const target = liveGuestTargets(options).find((t) => t.id === id);
    if (!target) {
      return;
    }
    const info = pageTargetInfo(target);
    broadcastJsonFrame(
      clients,
      {
        method: "Target.targetInfoChanged",
        params: { targetInfo: info },
      },
      id,
    );
  };

  const server = http.createServer((req, res) => {
    void handleHttp(req, res, options);
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      syncDebuggerListeners();
      handleUpgrade(
        req,
        socket as Socket,
        head,
        clients,
        options,
        syncDebuggerListeners,
        notifyTargetDestroyed,
        notifyTargetCreated,
      );
    } catch {
      socket.destroy();
    }
  });

  const port = await listenCdpPort(server, options.preferredPort);
  if (port === FORBIDDEN_CDP_PORT) {
    await closeServer(server);
    throw new Error("CDP proxy refused to bind forbidden port 9222");
  }

  return {
    port,
    notifyTargetDestroyed,
    notifyTargetCreated,
    notifyTargetInfoChanged,
    close: async () => {
      for (const client of clients.keys()) {
        client.destroy();
      }
      clients.clear();
      for (const [id, entry] of debuggerListeners) {
        try {
          const dbg = getDebugger(entry.wc);
          dbg.off("message", entry.listener);
          if (dbg.isAttached()) {
            dbg.detach();
          }
        } catch {
          // ignore
        }
        debuggerListeners.delete(id);
      }
      await closeServer(server);
    },
  };
}

/** @deprecated Use startMultiBrowserCdpProxy — kept for smoke tests that pass a single WebContents. */
export async function startBrowserCdpProxy(
  webContents: WebContents,
  options: {
    onClientActivity?: MultiBrowserCdpProxyOptions["onClientActivity"];
  } = {},
): Promise<BrowserCdpProxy> {
  const id = "eco-guest";
  return startMultiBrowserCdpProxy({
    getTargets: () => (webContents && !webContents.isDestroyed() ? [{ id, webContents }] : []),
    ...(options.onClientActivity ? { onClientActivity: options.onClientActivity } : {}),
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: MultiBrowserCdpProxyOptions,
): Promise<void> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const port = Number((req.socket.address() as AddressInfo | null)?.port ?? 0);
  const targets = liveGuestTargets(options);
  const first = targets[0];
  const wsUrl = first
    ? `ws://127.0.0.1:${port}/devtools/page/${first.id}`
    : `ws://127.0.0.1:${port}/devtools/browser`;

  if (url.pathname === "/json/version" || url.pathname === "/json/version/") {
    writeJson(res, 200, {
      Browser: "Mori-Browser/1.0",
      "Protocol-Version": "1.3",
      "User-Agent": "Mori Built-in Browser",
      "V8-Version": process.versions.v8,
      "WebKit-Version": process.versions.chrome,
      webSocketDebuggerUrl: wsUrl,
    });
    return;
  }

  if (
    url.pathname === "/json" ||
    url.pathname === "/json/" ||
    url.pathname === "/json/list" ||
    url.pathname === "/json/list/"
  ) {
    writeJson(res, 200, listJsonPages(targets, port));
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

interface CdpClientState {
  /** One-shot DOM.focus params to replay after native guest focus before keyboard insert. */
  pendingDomFocusBySession: Map<string, Record<string, unknown>>;
}

function sessionKey(clientSessionId: string | undefined, target: BrowserCdpTarget): string {
  return clientSessionId?.trim() ? clientSessionId : target.id;
}

function clearPendingDomFocus(clientState: CdpClientState, sessionKey: string): void {
  clientState.pendingDomFocusBySession.delete(sessionKey);
}

function clearsPendingDomFocus(method: string): boolean {
  return method !== "DOM.focus" && method !== "Input.insertText" && method !== "Input.dispatchKeyEvent";
}

function focusGuestWebContents(wc: WebContents): void {
  assertBrowserGuestWebContents(wc);
  try {
    wc.focus();
  } catch (error) {
    throw new Error(
      `Failed to focus guest webContents: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type ElectronInputModifier =
  | "shift"
  | "control"
  | "ctrl"
  | "alt"
  | "meta"
  | "command"
  | "cmd"
  | "iskeypad"
  | "isautorepeat"
  | "leftbuttondown"
  | "middlebuttondown"
  | "rightbuttondown"
  | "capslock"
  | "numlock"
  | "left"
  | "right";

function modifiersFromCdp(params: Record<string, unknown>): ElectronInputModifier[] {
  const mods: Array<"shift" | "ctrl" | "alt" | "meta"> = [];
  const bitmap = Number(params.modifiers ?? 0);
  if (bitmap & 1) mods.push("alt");
  if (bitmap & 2) mods.push("ctrl");
  if (bitmap & 4) mods.push("meta");
  if (bitmap & 8) mods.push("shift");
  return mods;
}

function resolveSendInputKeyCode(params: Record<string, unknown>): string {
  const text = typeof params.text === "string" ? params.text : "";
  if (text.length === 1) {
    return text;
  }
  const key = typeof params.key === "string" ? params.key : "";
  if (key.length === 1) {
    return key;
  }
  if (key) {
    return key;
  }
  const code = typeof params.code === "string" ? params.code : "";
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3);
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  return code;
}

function mapCdpKeyEventToSendInput(params: Record<string, unknown>): GuestSendInputEvent | null {
  const eventType = params.type;
  if (eventType !== "keyDown" && eventType !== "keyUp" && eventType !== "char") {
    return null;
  }
  const keyCode = resolveSendInputKeyCode(params);
  if (!keyCode) {
    return null;
  }
  const modifiers = modifiersFromCdp(params);
  if (eventType === "char") {
    return { type: "char", keyCode, ...(modifiers.length > 0 ? { modifiers } : {}) };
  }
  return {
    type: eventType,
    keyCode,
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

async function replayPendingDomFocus(
  dbg: DebuggerLike,
  clientState: CdpClientState,
  key: string,
  context: string,
): Promise<void> {
  const pendingParams = clientState.pendingDomFocusBySession.get(key);
  if (!pendingParams) {
    return;
  }
  try {
    await dbg.sendCommand("DOM.focus", pendingParams);
  } catch (error) {
    clearPendingDomFocus(clientState, key);
    throw new Error(
      `DOM.focus replay failed before ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function prepareGuestKeyboardTarget(
  target: BrowserCdpTarget,
  dbg: DebuggerLike,
  clientState: CdpClientState,
  key: string,
  options: MultiBrowserCdpProxyOptions,
  context: string,
): Promise<void> {
  if (options.onPrepareGuestKeyboardInput) {
    await options.onPrepareGuestKeyboardInput(target);
  }
  focusGuestWebContents(target.webContents);
  await replayPendingDomFocus(dbg, clientState, key, context);
}

/**
 * Chromium only supports selection APIs on text-like inputs.
 * email / number / time / date / etc. throw InvalidStateError on selectionStart/setSelectionRange.
 */
export function inputTypeSupportsSelection(type: string | undefined): boolean {
  const normalized = (type ?? "text").trim().toLowerCase() || "text";
  return (
    normalized === "text" ||
    normalized === "search" ||
    normalized === "tel" ||
    normalized === "url" ||
    normalized === "password"
  );
}

async function guestInsertTextViaRuntime(dbg: DebuggerLike, text: string): Promise<void> {
  const evalResult = (await dbg.sendCommand("Runtime.evaluate", {
    expression: `(function(text){
      const el = document.activeElement;
      if (!el) return { ok: false, reason: "no activeElement" };

      const fire = () => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const setNativeValue = (node, value) => {
        const proto =
          node instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(node, value);
        } else {
          node.value = value;
        }
      };

      if (el instanceof HTMLTextAreaElement) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const next = el.value.slice(0, start) + text + el.value.slice(end);
        setNativeValue(el, next);
        const pos = start + text.length;
        try { el.setSelectionRange(pos, pos); } catch (_) {}
        fire();
        return { ok: true, value: el.value };
      }

      if (el instanceof HTMLInputElement) {
        const type = (el.type || "text").toLowerCase();
        const selectionOk = ${JSON.stringify([
          "text",
          "search",
          "tel",
          "url",
          "password",
        ])}.includes(type);
        if (selectionOk) {
          let start = el.value.length;
          let end = el.value.length;
          try {
            start = el.selectionStart ?? el.value.length;
            end = el.selectionEnd ?? el.value.length;
          } catch (_) {}
          const next = el.value.slice(0, start) + text + el.value.slice(end);
          setNativeValue(el, next);
          const pos = start + text.length;
          try { el.setSelectionRange(pos, pos); } catch (_) {}
          fire();
          return { ok: true, value: el.value, type };
        }
        // email / number / time / date / … — no selection APIs.
        // Always set the provided text (fill/type send the full value via insertText).
        setNativeValue(el, text);
        fire();
        return { ok: true, value: el.value, type };
      }

      if (el.isContentEditable) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
        } else {
          el.textContent = (el.textContent ?? "") + text;
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        return { ok: true };
      }
      return { ok: false, reason: "unsupported activeElement:" + (el.tagName || "?") };
    })(${JSON.stringify(text)})`,
    returnByValue: true,
  })) as { result?: { value?: { ok?: boolean; reason?: string }; exceptionDetails?: unknown } };
      const value = evalResult?.result?.value;
  if (!value?.ok) {
    throw new Error(`Guest insertText failed: ${value?.reason ?? "unknown"}`);
  }
}

function guestDispatchKeyViaSendInputEvent(wc: WebContents, params: Record<string, unknown>): void {
  assertBrowserGuestWebContents(wc);
  const mapped = mapCdpKeyEventToSendInput(params);
  if (!mapped) {
    throw new Error(`Unsupported CDP key event: ${JSON.stringify(params)}`);
  }
  wc.sendInputEvent(mapped);
}

function mapCdpMouseButton(params: Record<string, unknown>): "left" | "middle" | "right" {
  const button = params.button;
  if (button === "middle" || button === 1) {
    return "middle";
  }
  if (button === "right" || button === 2) {
    return "right";
  }
  return "left";
}

export function mapCdpMouseEventToSendInput(params: Record<string, unknown>): GuestSendInputEvent | null {
  const eventType = params.type;
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const modifiers = modifiersFromCdp(params);
  const mods = modifiers.length > 0 ? { modifiers } : {};
  const button = mapCdpMouseButton(params);
  const clickCountRaw = Number(params.clickCount ?? 1);
  const clickCount = Number.isFinite(clickCountRaw) && clickCountRaw > 0 ? clickCountRaw : 1;

  if (eventType === "mousePressed") {
    return { type: "mouseDown", x, y, button, clickCount, ...mods } as GuestSendInputEvent;
  }
  if (eventType === "mouseReleased") {
    return { type: "mouseUp", x, y, button, clickCount, ...mods } as GuestSendInputEvent;
  }
  if (eventType === "mouseMoved") {
    return { type: "mouseMove", x, y, ...mods } as GuestSendInputEvent;
  }
  if (eventType === "mouseWheel") {
    const deltaX = Number(params.deltaX ?? 0);
    const deltaY = Number(params.deltaY ?? 0);
    return {
      type: "mouseWheel",
      x,
      y,
      deltaX: Number.isFinite(deltaX) ? deltaX : 0,
      deltaY: Number.isFinite(deltaY) ? deltaY : 0,
      ...mods,
    } as GuestSendInputEvent;
  }
  return null;
}

function guestDispatchMouseViaSendInputEvent(wc: WebContents, params: Record<string, unknown>): void {
  assertBrowserGuestWebContents(wc);
  const mapped = mapCdpMouseEventToSendInput(params);
  if (!mapped) {
    throw new Error(`Unsupported CDP mouse event: ${JSON.stringify(params)}`);
  }
  wc.sendInputEvent(mapped);
}

/** Map first touch point to mouse events so touch never goes through embedder-routed CDP Input. */
function guestDispatchTouchViaSendInputEvent(wc: WebContents, params: Record<string, unknown>): void {
  assertBrowserGuestWebContents(wc);
  const touchType = params.type;
  const points = Array.isArray(params.touchPoints) ? params.touchPoints : [];
  const first = points[0] as Record<string, unknown> | undefined;
  const x = Number(first?.x ?? params.x);
  const y = Number(first?.y ?? params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Unsupported CDP touch event: ${JSON.stringify(params)}`);
  }
  if (touchType === "touchStart") {
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    return;
  }
  if (touchType === "touchMove") {
    wc.sendInputEvent({ type: "mouseMove", x, y });
    return;
  }
  if (touchType === "touchEnd" || touchType === "touchCancel") {
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return;
  }
  throw new Error(`Unsupported CDP touch event type: ${String(touchType)}`);
}

/**
 * Electron `<webview>`: raw `debugger.sendCommand("Page.reload")` can reload the embedder
 * BrowserWindow instead of the guest (upstream draft electron#51075). Prefer WebContents APIs.
 */
export function applyGuestPageReload(
  webContents: Pick<WebContents, "reload" | "reloadIgnoringCache" | "isDestroyed" | "getType">,
  params: Record<string, unknown> = {},
): Record<string, never> {
  assertBrowserGuestWebContents(webContents);
  if (params.ignoreCache === true) {
    webContents.reloadIgnoringCache();
  } else {
    webContents.reload();
  }
  return {};
}

export async function applyGuestPageNavigate(
  webContents: Pick<WebContents, "loadURL" | "isDestroyed" | "getType">,
  params: Record<string, unknown> = {},
): Promise<Record<string, never>> {
  assertBrowserGuestWebContents(webContents);
  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (!url) {
    throw new Error("Page.navigate requires url");
  }
  await webContents.loadURL(url);
  return {};
}

export function applyGuestPageNavigateToHistoryEntry(
  webContents: Pick<WebContents, "isDestroyed" | "getType"> & {
    navigationHistory?: { goToIndex?: (index: number) => void };
    goToIndex?: (index: number) => void;
  },
  params: Record<string, unknown> = {},
): Record<string, never> {
  assertBrowserGuestWebContents(webContents);
  const entryId = Number(params.entryId);
  if (!Number.isFinite(entryId) || entryId < 0) {
    throw new Error("Page.navigateToHistoryEntry requires entryId");
  }
  if (typeof webContents.navigationHistory?.goToIndex === "function") {
    webContents.navigationHistory.goToIndex(entryId);
  } else if (typeof webContents.goToIndex === "function") {
    webContents.goToIndex(entryId);
  } else {
    throw new Error("Guest navigationHistory.goToIndex is unavailable");
  }
  return {};
}

export function applyGuestPageBringToFront(
  webContents: Pick<WebContents, "focus" | "isDestroyed" | "getType">,
): Record<string, never> {
  assertBrowserGuestWebContents(webContents);
  webContents.focus();
  return {};
}

/**
 * Electron routes CDP Input.* at browser-process focus, which can leak to the embedder
 * (Composer / main window) even when commands are sent on the guest debugger.
 * Route all synthetic Input through guest webContents APIs instead.
 */
async function forwardGuestInput(
  target: BrowserCdpTarget,
  dbg: DebuggerLike,
  method: string,
  params: Record<string, unknown>,
  clientState: CdpClientState,
  key: string,
  options: MultiBrowserCdpProxyOptions,
): Promise<unknown> {
  assertTargetAllowed(options, target);
  await prepareGuestKeyboardTarget(target, dbg, clientState, key, options, method);

  if (method === "Input.insertText") {
    const text = typeof params.text === "string" ? params.text : "";
    await guestInsertTextViaRuntime(dbg, text);
    clearPendingDomFocus(clientState, key);
    return {};
  }

  if (method === "Input.dispatchKeyEvent") {
    guestDispatchKeyViaSendInputEvent(target.webContents, params);
    clearPendingDomFocus(clientState, key);
    return {};
  }

  if (method === "Input.dispatchMouseEvent") {
    guestDispatchMouseViaSendInputEvent(target.webContents, params);
    clearPendingDomFocus(clientState, key);
    return {};
  }

  if (method === "Input.dispatchTouchEvent") {
    guestDispatchTouchViaSendInputEvent(target.webContents, params);
    clearPendingDomFocus(clientState, key);
    return {};
  }

  // Remaining Input.* still must hit the guest debugger only (never main window).
  clearPendingDomFocus(clientState, key);
  return dbg.sendCommand(method, params);
}

function resolveTarget(
  options: MultiBrowserCdpProxyOptions,
  targetId?: string,
  sessionId?: string,
): BrowserCdpTarget | undefined {
  const targets = liveGuestTargets(options);
  if (targetId) {
    return targets.find((t) => t.id === targetId);
  }
  if (sessionId) {
    return targets.find((t) => t.id === sessionId);
  }
  return targets[0];
}

async function tryHandleTargetDomain(
  method: string,
  params: Record<string, unknown> | undefined,
  socket: Socket,
  options: MultiBrowserCdpProxyOptions,
  syncDebuggerListeners: () => void,
  notifyTargetDestroyed: (targetId: string) => void,
  _notifyTargetCreated: (targetId: string) => void,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  if (method === "Target.getTargets") {
    const targets = liveGuestTargets(options);
    return {
      handled: true,
      result: { targetInfos: targets.map((t) => pageTargetInfo(t)) },
    };
  }
  if (method === "Target.getTargetInfo") {
    const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
    const target = resolveTarget(options, targetId);
    if (!target) {
      throw new Error("Target not found");
    }
    return { handled: true, result: { targetInfo: pageTargetInfo(target) } };
  }
  if (method === "Target.setDiscoverTargets") {
    if (params?.discover !== false) {
      for (const target of liveGuestTargets(options)) {
        if (target.webContents && !target.webContents.isDestroyed()) {
          writeJsonFrame(socket, {
            method: "Target.targetCreated",
            params: { targetInfo: pageTargetInfo(target) },
          });
        }
      }
    }
    return { handled: true, result: {} };
  }
  if (method === "Target.setAutoAttach" || method === "Target.setRemoteLocations") {
    return { handled: true, result: {} };
  }
  if (method === "Target.detachFromTarget") {
    return { handled: true, result: {} };
  }
  if (method === "Target.activateTarget") {
    const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
    if (targetId) {
      options.onActivateTarget?.(targetId);
      options.onClientActivity?.({
        kind: "cdp-method",
        method,
        targetId,
      });
    }
    return { handled: true, result: {} };
  }
  if (method === "Target.closeTarget") {
    const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
    if (targetId && options.onCloseTarget) {
      await options.onCloseTarget(targetId);
      // Only notify clients if Eco actually removed the target (UI × / dispose).
      const stillThere = liveGuestTargets(options).some((t) => t.id === targetId);
      if (!stillThere) {
        notifyTargetDestroyed(targetId);
      }
    }
    return { handled: true, result: { success: true } };
  }
  if (method === "Target.createTarget") {
    if (!options.onCreateTarget) {
      throw new Error("Target.createTarget is not supported");
    }
    const url = typeof params?.url === "string" ? params.url : undefined;
    const created = await options.onCreateTarget(url);
    assertTargetAllowed(options, created);
    syncDebuggerListeners();
    options.onClientActivity?.({
      kind: "cdp-method",
      method,
      targetId: created.id,
      ...(url ? { url } : {}),
    });
    // New pages already broadcast Target.targetCreated from BrowserHost.createBrowserInScope.
    // Blank reuse keeps the same targetId — clients get fresh URL via targetInfoChanged on navigate.
    return { handled: true, result: { targetId: created.id } };
  }
  if (method === "Target.attachToTarget") {
    const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
    const target = resolveTarget(options, targetId);
    if (!target) {
      throw new Error("Target not found");
    }
    ensureDebuggerAttached(target.webContents);
    syncDebuggerListeners();
    const targetInfo = pageTargetInfo(target);
    writeJsonFrame(socket, {
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.id,
        targetInfo,
        waitingForDebugger: false,
      },
    });
    return { handled: true, result: { sessionId: target.id } };
  }
  if (method === "Browser.getVersion") {
    return {
      handled: true,
      result: {
        protocolVersion: "1.3",
        product: "Mori-Browser/1.0",
        revision: process.versions.electron ?? "",
        userAgent: "Mori Built-in Browser",
        jsVersion: process.versions.v8 ?? "",
      },
    };
  }
  return { handled: false };
}

function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  clients: Map<Socket, string | undefined>,
  options: MultiBrowserCdpProxyOptions,
  syncDebuggerListeners: () => void,
  notifyTargetDestroyed: (targetId: string) => void,
  notifyTargetCreated: (targetId: string) => void,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const boundTargetId = url.searchParams.get("targetId") ?? undefined;
  if (boundTargetId !== undefined) {
    const scopeOptions = options;
    const getTargets = () => liveGuestTargets(scopeOptions).filter((t) => t.id === boundTargetId);
    if (getTargets().length === 0) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const assertBoundTarget = (targetId: string) => {
      if (targetId !== boundTargetId || getTargets().length === 0) {
        throw new Error("Target not found in bound browser connection");
      }
    };
    // A page-bound CLI must neither discover peers nor retarget after its page closes.
    // Changing this URL makes agent-browser reconnect and clear the previous page's refs.
    options = {
      ...scopeOptions,
      getTargets,
      onCreateTarget: async () => {
        throw new Error("Use agent_browser_tab_new to create a browser tab");
      },
      onActivateTarget: (targetId) => {
        assertBoundTarget(targetId);
        scopeOptions.onActivateTarget?.(targetId);
      },
      onCloseTarget: async (targetId) => {
        assertBoundTarget(targetId);
        await scopeOptions.onCloseTarget?.(targetId);
      },
    };
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n",
  );
  if (head.length > 0) {
    socket.unshift(head);
  }

  clients.set(socket, boundTargetId);
  const clientState: CdpClientState = { pendingDomFocusBySession: new Map() };
  let buffer: Buffer = Buffer.alloc(0);
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clientState.pendingDomFocusBySession.clear();
    clients.delete(socket);
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      buffer = readFrames(buffer, (payload, opcode) => {
        if (opcode === 0x8) {
          socket.end();
          cleanup();
          return;
        }
        if (opcode === 0x9) {
          const pong = Buffer.alloc(2 + payload.length);
          pong[0] = 0x8a;
          pong[1] = payload.length;
          payload.copy(pong, 2);
          socket.write(pong);
          return;
        }
        if (opcode !== 0x1 && opcode !== 0x2) {
          return;
        }
        void handleClientMessage(
          payload.toString("utf8"),
          socket,
          clientState,
          options,
          syncDebuggerListeners,
          notifyTargetDestroyed,
          notifyTargetCreated,
        );
      });
    } catch {
      socket.destroy();
      cleanup();
    }
  });
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

async function handleClientMessage(
  text: string,
  socket: Socket,
  clientState: CdpClientState,
  options: MultiBrowserCdpProxyOptions,
  syncDebuggerListeners: () => void,
  notifyTargetDestroyed: (targetId: string) => void,
  notifyTargetCreated: (targetId: string) => void,
): Promise<void> {
  let message: {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    return;
  }
  if (typeof message.method !== "string") {
    return;
  }
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};
  const clientSessionId =
    typeof message.sessionId === "string" && message.sessionId.trim() ? message.sessionId : undefined;

  try {
    const shim = await tryHandleTargetDomain(
      method,
      params,
      socket,
      options,
      syncDebuggerListeners,
      notifyTargetDestroyed,
      notifyTargetCreated,
    );
    let result: unknown;
    if (shim.handled) {
      result = shim.result;
    } else {
      const target = resolveTarget(options, undefined, clientSessionId);
      if (!target) {
        throw new Error("No browser target available in this session CDP");
      }
      assertTargetAllowed(options, target);
      const key = sessionKey(clientSessionId, target);

      if (
        method === "Page.reload" ||
        method === "Page.navigate" ||
        method === "Page.navigateToHistoryEntry" ||
        method === "Page.bringToFront"
      ) {
        if (clearsPendingDomFocus(method)) {
          clearPendingDomFocus(clientState, key);
        }
        if (method === "Page.reload") {
          result = applyGuestPageReload(target.webContents, params);
        } else if (method === "Page.navigate") {
          result = await applyGuestPageNavigate(target.webContents, params);
        } else if (method === "Page.navigateToHistoryEntry") {
          result = applyGuestPageNavigateToHistoryEntry(target.webContents, params);
        } else {
          result = applyGuestPageBringToFront(target.webContents);
        }
      } else if (method === "DOM.focus") {
        // Store synchronously before await so a pipelined Input.insertText in the same tick still finds it.
        const dbg = ensureDebuggerAttached(target.webContents);
        clientState.pendingDomFocusBySession.set(key, { ...params });
        try {
          result = await dbg.sendCommand(method, params);
        } catch (error) {
          clearPendingDomFocus(clientState, key);
          throw error;
        }
      } else if (method.startsWith("Input.")) {
        const dbg = ensureDebuggerAttached(target.webContents);
        result = await forwardGuestInput(
          target,
          dbg,
          method,
          params,
          clientState,
          key,
          options,
        );
        const mouse =
          method === "Input.dispatchMouseEvent" ? parseBrowserAgentPresenceMouse(params) : null;
        options.onClientActivity?.({
          kind: "cdp-method",
          method,
          targetId: target.id,
          ...(mouse ? { mouse } : {}),
        });
      } else {
        const dbg = ensureDebuggerAttached(target.webContents);
        if (clearsPendingDomFocus(method)) {
          clearPendingDomFocus(clientState, key);
        }
        result = await dbg.sendCommand(method, params);
      }

      if (
        method === "Page.navigate" ||
        method === "Page.navigateToHistoryEntry" ||
        method === "Page.reload" ||
        method === "Page.bringToFront"
      ) {
        options.onClientActivity?.({
          kind: "cdp-method",
          method,
          targetId: target.id,
        });
      } else if (isBrowserAgentPresenceCdpMethod(method) && !method.startsWith("Input.")) {
        options.onClientActivity?.({
          kind: "cdp-method",
          method,
          targetId: target.id,
        });
      }
    }

    if (id === undefined) {
      return;
    }
    writeJsonFrame(socket, {
      id,
      ...(clientSessionId ? { sessionId: clientSessionId } : {}),
      result: result ?? {},
    });
  } catch (error) {
    if (id === undefined) {
      return;
    }
    writeJsonFrame(socket, {
      id,
      ...(clientSessionId ? { sessionId: clientSessionId } : {}),
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function listenCdpPort(server: http.Server, preferredPort?: number): Promise<number> {
  if (preferredPort !== undefined && preferredPort > 0 && preferredPort !== FORBIDDEN_CDP_PORT) {
    return listenOnPort(server, preferredPort).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        process.stderr.write(
          `[eco-dev-cdp] port ${preferredPort} in use; falling back to ephemeral CDP port\n`,
        );
        return listenOnPort(server, 0);
      }
      throw error;
    });
  }
  return listenOnPort(server, 0);
}

function listenOnPort(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("CDP proxy failed to bind"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", onListening);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
