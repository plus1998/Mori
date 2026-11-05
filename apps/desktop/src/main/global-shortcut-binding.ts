import { SHORTCUT_DEFINITIONS, type KeyboardShortcutsSnapshot } from "../shared/keyboard-shortcuts";

export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Owns one registration. A conflict leaves the binding empty. */
export class GlobalShortcutBinding {
  private current = "";

  constructor(
    private readonly registry: GlobalShortcutRegistry,
    private readonly callback: () => void,
  ) {}

  set(accelerator: string): boolean {
    if (accelerator === this.current) return true;
    const registered = !accelerator || this.registry.register(accelerator, this.callback);
    if (this.current) this.registry.unregister(this.current);
    this.current = registered ? accelerator : "";
    return registered;
  }
}
export function checkGlobalShortcutConflicts(
  snapshot: KeyboardShortcutsSnapshot,
  registry: GlobalShortcutRegistry & { isRegistered(accelerator: string): boolean },
): KeyboardShortcutsSnapshot {
  const bindings = structuredClone(snapshot.bindings);
  const conflicts = { ...snapshot.conflicts };
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.scope !== "global") continue;
    const accelerator = bindings[definition.id]?.[0];
    if (!accelerator) continue;
    delete conflicts[definition.id];
    // Electron only reports registrations owned by this app here.
    if (registry.isRegistered(accelerator)) continue;
    if (registry.register(accelerator, () => {})) registry.unregister(accelerator);
    else {
      bindings[definition.id] = [];
      conflicts[definition.id] = accelerator;
    }
  }
  return { bindings, conflicts };
}
