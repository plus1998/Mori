import { createRequire } from "node:module";
import path from "node:path";
import { writeFileSync } from "node:fs";
import type { WebContents } from "electron";
import { browserFocusHookProfile } from "./browser-agent-focus-profile";

interface NativeFocusHook {
  library: unknown;
  install: () => number;
  uninstall: () => number;
  error: () => string;
  blocked: () => number | bigint;
  allowed: () => number | bigint;
}

let binding: NativeFocusHook | undefined;
let loadError: Error | undefined;

function loadFocusHook(): NativeFocusHook {
  if (binding) return binding;
  if (loadError) throw loadError;
  let diagnosticsPath: string | undefined;
  let libraryPath: string | undefined;
  const diagnostic = (status: string, detail?: string) => {
    if (!diagnosticsPath) return;
    try {
      writeFileSync(diagnosticsPath, JSON.stringify({
        time: new Date().toISOString(), status, detail, electron: process.versions.electron,
        platform: process.platform, arch: process.arch, libraryPath,
        blocked: binding ? String(binding.blocked()) : undefined,
        allowed: binding ? String(binding.allowed()) : undefined,
      }, null, 2));
    } catch (error) {
      console.error(`[browser-focus-hook] diagnostic write failed: ${String(error)}`);
    }
  };
  try {
    const profile = browserFocusHookProfile(process.platform, process.arch, process.versions.electron);
    const require = createRequire(import.meta.url);
    const { app } = require("electron") as typeof import("electron");
    const koffi = require("koffi") as typeof import("koffi");
    diagnosticsPath = path.join(app.getPath("userData"), "browser-focus-hook.json");
    libraryPath = path.join(app.getAppPath(), "dist/native/browser-focus-hook", profile.target, profile.library)
      .replace(/\.asar(?=[/\\])/, ".asar.unpacked");
    diagnostic("loading");
    // Pin the library for process lifetime: its replacement function must never be unloaded.
    const library = koffi.load(libraryPath);
    const hook: NativeFocusHook = {
      library,
      install: library.func("int mori_browser_focus_install()"),
      uninstall: library.func("int mori_browser_focus_uninstall()"),
      error: library.func("const char *mori_browser_focus_error()"),
      blocked: library.func("uint64_t mori_browser_focus_blocked()"),
      allowed: library.func("uint64_t mori_browser_focus_allowed()"),
    };
    diagnostic("installing");
    if (hook.install() !== 0) throw new Error(hook.error());
    binding = hook;
    diagnostic("installed");
    const timer = process.env.MORI_BROWSER_FOCUS_DIAGNOSTICS === "1"
      ? setInterval(() => diagnostic("installed"), 5000) : undefined;
    timer?.unref();
    app.once("will-quit", () => {
      if (timer) clearInterval(timer);
      if (hook.uninstall() !== 0) {
        console.error(`[browser-focus-hook] ${hook.error()}`);
        diagnostic("uninstall-failed", hook.error());
      } else diagnostic("uninstalled");
    });
    return hook;
  } catch (error) {
    loadError = new Error(`无法启用 Agent 点击焦点隔离，已阻止原生点击：${error instanceof Error ? error.message : String(error)}`);
    diagnostic("failed", loadError.message);
    throw loadError;
  }
}

/** Installed lazily by the Agent proxy; native event provenance controls each focus decision. */
export function submitBrowserAgentPointer<T>(wc: WebContents, submit: () => T): T {
  if (wc.isDestroyed() || wc.getType() !== "webview") throw new Error("Agent input requires a live webview guest");
  // Native event provenance, not Promise lifetime, decides whether focus propagates.
  loadFocusHook();
  return submit();
}
