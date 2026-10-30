import fs from "node:fs";
import path from "node:path";
import {
  defaultShortcutBindings,
  type ShortcutBindings,
  validateShortcutBindings,
} from "../shared/keyboard-shortcuts";

export class KeyboardShortcutsStore {
  private bindings: ShortcutBindings;
  constructor(
    private readonly file: string,
    private readonly platform: string,
  ) {
    this.bindings = defaultShortcutBindings(platform);
  }
  load(): void {
    if (fs.existsSync(this.file)) {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        const bindings = { ...saved } as Record<string, unknown>;
        for (const id of [
          "undo", "redo", "cut", "copy", "paste", "selectAll",
          "reload", "forceReload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut",
          "togglefullscreen", "minimize", "close", "quit", "hide", "hideOthers",
        ]) delete bindings[id];
        this.bindings = validateShortcutBindings(bindings, this.platform);
      } else {
        this.bindings = validateShortcutBindings(saved, this.platform);
      }
      return;
    }
    // Preserve an existing Mori global shortcut when moving its control into General.
    const legacy = path.join(path.dirname(this.file), "mori-assistant.json");
    if (fs.existsSync(legacy)) {
      const value = JSON.parse(fs.readFileSync(legacy, "utf8")) as { settings?: { shortcut?: string } };
      if (typeof value.settings?.shortcut === "string") {
        this.bindings = validateShortcutBindings(
          { ...this.bindings, "mori-floating": value.settings.shortcut ? [value.settings.shortcut] : [] },
          this.platform,
        );
      }
    }
  }
  get(): ShortcutBindings {
    return structuredClone(this.bindings);
  }
  save(value: ShortcutBindings): void {
    const next = validateShortcutBindings(value, this.platform);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.bindings = next;
  }
}
