import fs from "node:fs";
import path from "node:path";
import {
  defaultShortcutBindings,
  SHORTCUT_DEFINITIONS,
  type KeyboardShortcutsSnapshot,
  type ShortcutBindings,
  validateShortcutBindings,
} from "../shared/keyboard-shortcuts";

export class KeyboardShortcutsStore {
  private bindings: ShortcutBindings;
  private conflicts: Record<string, string> = {};
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
        const data = saved as Record<string, unknown>;
        // Accept the original flat bindings file as well as snapshots with conflict metadata.
        const rawBindings = "bindings" in data ? data.bindings : data;
        if (!rawBindings || typeof rawBindings !== "object" || Array.isArray(rawBindings))
          throw new Error("快捷键配置无效。");
        const bindings = { ...rawBindings } as Record<string, unknown>;
        for (const id of [
          "undo", "redo", "cut", "copy", "paste", "selectAll",
          "reload", "forceReload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut",
          "togglefullscreen", "minimize", "close", "quit", "hide", "hideOthers",
        ]) delete bindings[id];
        this.bindings = validateShortcutBindings(bindings, this.platform);
        this.conflicts = data.conflicts && typeof data.conflicts === "object" && !Array.isArray(data.conflicts)
          ? this.validConflicts(data.conflicts as Record<string, string>, this.bindings)
          : {};
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
  snapshot(): KeyboardShortcutsSnapshot {
    return { bindings: this.get(), conflicts: { ...this.conflicts } };
  }
  private validConflicts(conflicts: Record<string, string>, bindings: ShortcutBindings): Record<string, string> {
    return Object.fromEntries(
      Object.entries(conflicts).filter(([id, key]) =>
        typeof key === "string" && key.length > 0 && bindings[id]?.length === 0 &&
        SHORTCUT_DEFINITIONS.some(def => def.id === id && def.scope === "global"),
      ),
    );
  }
  clearConflictingBinding(id: string, accelerator: string): boolean {
    if (this.bindings[id]?.[0] !== accelerator) return false;
    this.save({ ...this.bindings, [id]: [] }, { ...this.conflicts, [id]: accelerator });
    return true;
  }
  save(value: ShortcutBindings, conflicts = this.conflicts): void {
    const next = validateShortcutBindings(value, this.platform);
    const nextConflicts = this.validConflicts(conflicts, next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ bindings: next, conflicts: nextConflicts }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.bindings = next;
    this.conflicts = nextConflicts;
  }
}
