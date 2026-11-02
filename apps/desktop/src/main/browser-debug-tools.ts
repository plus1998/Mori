import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { AgentBrowserMcpToolResult } from "./agent-browser-cli-bridge";
import { assertBrowserGuestWebContents } from "./browser-cdp-proxy";
import { agentBrowserTextResult } from "./browser-native-agent-tools";

// These domains operate on the attached guest. Target is limited to child auto-attach;
// browser-wide Browser, Storage and Tracing commands are not webpage operations.
const PAGE_DOMAINS = new Set([
  "Accessibility", "Animation", "Audits", "CSS", "DOM", "DOMDebugger", "DOMSnapshot",
  "Debugger", "HeapProfiler", "LayerTree", "Log", "Network", "Overlay", "Page",
  "Performance", "Profiler", "Runtime", "Security",
]);
const EXCLUDED_METHODS = new Set([
  "DOM.focus", "Page.bringToFront", "Page.setDownloadBehavior",
  "Network.clearBrowserCache", "Network.clearBrowserCookies", "Network.getAllCookies",
  "Network.getCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies",
]);
const CHILD_TARGET_EVENTS = new Set(["Target.attachedToTarget", "Target.detachedFromTarget"]);
const INLINE_LIMIT = 48_000;
const COMMAND_TIMEOUT_MS = 30_000;

function integer(value: unknown, defaultValue: number, min: number, max: number, name: string): number {
  const result = value ?? defaultValue;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return result;
}

/** DevTools access is bound directly to one real webview, never to the main window. */
export async function invokeGuestCdp(
  guest: WebContents,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentBrowserMcpToolResult> {
  const allowedKeys = new Set(["method", "params", "sessionId", "captureEvents", "waitMs", "maxEvents", "output"]);
  if (Object.keys(args).some(key => !allowedKeys.has(key))) throw new Error("Unknown page CDP argument.");
  const method = args.method;
  if (typeof method !== "string" || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method) ||
      (!PAGE_DOMAINS.has(method.split(".")[0]!) && method !== "Target.setAutoAttach") || EXCLUDED_METHODS.has(method))
    throw new Error(`CDP method is not available for a single webpage: ${String(method)}`);
  if (args.params !== undefined && (!args.params || typeof args.params !== "object" || Array.isArray(args.params)))
    throw new Error("CDP params must be an object.");
  if (args.sessionId !== undefined && (typeof args.sessionId !== "string" || !args.sessionId.trim()))
    throw new Error("sessionId must be a non-empty child session ID from this guest's Target.attachedToTarget event.");
  let params = args.params as Record<string, unknown> | undefined;
  if (method === "Target.setAutoAttach") {
    if (params && Object.keys(params).some(key => key !== "autoAttach"))
      throw new Error("Target.setAutoAttach accepts only autoAttach; child scope and non-pausing flattened sessions are fixed.");
    if (params?.autoAttach !== undefined && typeof params.autoAttach !== "boolean") throw new Error("autoAttach must be a boolean.");
    params = { autoAttach: params?.autoAttach ?? true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }] };
  }
  const filters = args.captureEvents ?? [];
  if (!Array.isArray(filters) || filters.some(filter => typeof filter !== "string" ||
      !/^[A-Za-z]+\.(?:[A-Za-z]+|\*)$/.test(filter) || (!PAGE_DOMAINS.has(filter.split(".")[0]!) && !CHILD_TARGET_EVENTS.has(filter))))
    throw new Error("captureEvents must contain page CDP event names or domain wildcards.");
  const waitMs = integer(args.waitMs, 0, 0, 5000, "waitMs");
  const maxEvents = integer(args.maxEvents, 1000, 1, 10000, "maxEvents");
  if (args.output !== undefined && args.output !== "inline" && args.output !== "file")
    throw new Error("output must be inline or file.");
  signal?.throwIfAborted();
  assertBrowserGuestWebContents(guest);
  const dbg = guest.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  const events: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  let totalEvents = 0;
  const onMessage = (_event: unknown, eventMethod: string, params: unknown, sessionId?: string) => {
    if (!filters.some(filter => filter === eventMethod || (filter.endsWith(".*") && eventMethod.startsWith(filter.slice(0, -1))))) return;
    totalEvents++;
    if (events.length < maxEvents) events.push({ method: eventMethod, params, ...(sessionId ? { sessionId } : {}) });
  };
  let commandTimer: ReturnType<typeof setTimeout> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let onDestroyed: (() => void) | undefined;
  let onDetach: ((_event: unknown, reason: string) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("Browser CDP call aborted."));
    onDestroyed = () => reject(new Error("Referenced browser guest was destroyed."));
    onDetach = (_event, reason) => reject(new Error(`Browser CDP detached: ${reason}`));
    signal?.addEventListener("abort", onAbort, { once: true });
    guest.once("destroyed", onDestroyed);
    dbg.once("detach", onDetach);
    commandTimer = setTimeout(() => reject(new Error(`CDP ${method} timed out after ${COMMAND_TIMEOUT_MS}ms.`)), COMMAND_TIMEOUT_MS);
  });
  dbg.on("message", onMessage);
  try {
    const command = args.sessionId
      ? dbg.sendCommand(method, params, args.sessionId as string)
      : dbg.sendCommand(method, params);
    const result = await Promise.race([command, interrupted]);
    if (waitMs) await Promise.race([new Promise<void>(resolve => { eventTimer = setTimeout(resolve, waitMs); }), interrupted]);
    signal?.throwIfAborted();
    const payload = {
      method, result,
      ...(filters.length ? { events, totalEvents, droppedEvents: totalEvents - events.length } : {}),
    };
    const text = JSON.stringify(payload);
    if (args.output !== "file" && text.length <= INLINE_LIMIT) return agentBrowserTextResult(text);
    // Retain the full result instead of silently clipping scripts, CSS or base64 assets.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-browser-cdp-"));
    const filePath = path.join(directory, "result.json");
    fs.writeFileSync(filePath, text, { mode: 0o600 });
    return agentBrowserTextResult(JSON.stringify({
      method, filePath, totalCharacters: text.length, complete: totalEvents === events.length,
      ...(filters.length ? { totalEvents, droppedEvents: totalEvents - events.length } : {}),
      instruction: "Read the JSON file for the full result. Page.getResourceContent uses result.content and result.base64Encoded; decode base64 to recover the original asset bytes.",
    }));
  } finally {
    dbg.off("message", onMessage);
    if (commandTimer) clearTimeout(commandTimer);
    if (eventTimer) clearTimeout(eventTimer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (onDestroyed) guest.off("destroyed", onDestroyed);
    if (onDetach) dbg.off("detach", onDetach);
  }
}
