import { app, type BrowserWindow } from "electron";
import { createRequire } from "node:module";
import path from "node:path";

let binding: {
  library: unknown;
  apply: (handle: Buffer) => string | null;
} | undefined;

export function fixMacWindowFrame(window: BrowserWindow): void {
  // Revalidate the Chromium workaround when updating the pinned runtime.
  if (process.platform !== "darwin" || process.versions.electron !== "45.1.0") return;
  if (!binding) {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as typeof import("koffi");
    const filename = path.join(app.getAppPath(), "dist/native/mac-window-frame-fix.dylib")
      .replace(/\.asar(?=[/\\])/, ".asar.unpacked");
    // The Objective-C methods keep pointing into this library for the process lifetime.
    const library = koffi.load(filename);
    const apply = library.func("const char *mori_fix_mac_window_frame(void *)");
    // On macOS Electron returns a buffer containing an NSView pointer.
    binding = { library, apply: handle => apply(koffi.decode(handle, "void *")) };
  }
  const error = binding.apply(window.getNativeWindowHandle());
  if (error) throw new Error(error);
}
