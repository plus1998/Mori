import { useEffect, useSyncExternalStore } from "react";
import {
  defaultShortcutBindings,
  type KeyboardShortcutsSnapshot,
  matchesShortcut,
  type ShortcutBindings,
  type ShortcutKeyEvent,
} from "../shared/keyboard-shortcuts";

const platform = () => (typeof window === "undefined" ? undefined : window.eco?.platform) ?? "darwin";
interface KeyboardShortcutsView extends KeyboardShortcutsSnapshot {
  loaded: boolean;
  error?: string;
}
let snapshot: KeyboardShortcutsView = { bindings: defaultShortcutBindings(platform()), loaded: false };
const listeners = new Set<() => void>();
let subscribers = 0;
let unsubscribe: (() => void) | undefined;
function update(next: KeyboardShortcutsSnapshot) {
  snapshot = { ...next, loaded: true };
  listeners.forEach((listener) => {
    listener();
  });
}
export function shortcutMatches(event: ShortcutKeyEvent, id: string): boolean {
  return matchesShortcut(event, id, snapshot.bindings, platform());
}
export function useKeyboardShortcuts() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
  useEffect(() => {
    subscribers++;
    if (subscribers === 1 && window.eco) {
      unsubscribe = window.eco.onKeyboardShortcutsChanged(update);
      void window.eco
        .getKeyboardShortcuts()
        .then(update)
        .catch((error) => {
          snapshot = {
            ...snapshot,
            loaded: false,
            error: `无法读取快捷键设置：${error instanceof Error ? error.message : String(error)}`,
          };
          listeners.forEach((listener) => {
            listener();
          });
        });
    }
    return () => {
      if (--subscribers === 0) {
        unsubscribe?.();
        unsubscribe = undefined;
      }
    };
  }, []);
  return current;
}
export async function saveKeyboardShortcuts(bindings: ShortcutBindings) {
  if (!window.eco) throw new Error("桌面快捷键服务未连接，请重启应用。");
  update(await window.eco.saveKeyboardShortcuts(bindings));
}
