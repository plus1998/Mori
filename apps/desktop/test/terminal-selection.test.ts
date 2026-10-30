import { describe, expect, test } from "bun:test";
import type { Terminal as GhosttyTerminalType } from "ghostty-web";
import { saveKeyboardShortcuts } from "../src/renderer/keyboard-shortcuts";
import {
  computeSelectAllRange,
  handleTerminalSelectionShortcut,
  installTerminalSelectionEnhancements,
  pasteClipboardIntoTerminal,
} from "../src/renderer/terminal-selection";
import { defaultShortcutBindings } from "../src/shared/keyboard-shortcuts";

interface StubSelectionManager {
  selectionStart: { col: number; absoluteRow: number } | null;
  selectionEnd: { col: number; absoluteRow: number } | null;
  isSelecting: boolean;
  copied: string[];
  selectAllCalls: number;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  selectAll(): void;
  pixelToCell(x: number, y: number): { col: number; row: number };
  viewportRowToAbsolute(row: number): number;
  markCurrentSelectionDirty(): void;
  requestRender(): void;
  copyToClipboard(text: string): Promise<void>;
  selectionChangedEmitter: { fire: () => void };
}

function createStubTerminal(): { terminal: GhosttyTerminalType; manager: StubSelectionManager } {
  const manager: StubSelectionManager = {
    selectionStart: null,
    selectionEnd: null,
    isSelecting: false,
    copied: [],
    selectAllCalls: 0,
    hasSelection: () => false,
    getSelection: () => "",
    clearSelection: () => undefined,
    selectAll: () => {
      manager.selectAllCalls += 1;
    },
    pixelToCell: () => ({ col: 0, row: 0 }),
    viewportRowToAbsolute: (row) => row,
    markCurrentSelectionDirty: () => undefined,
    requestRender: () => undefined,
    copyToClipboard: async (text: string) => {
      manager.copied.push(text);
    },
    selectionChangedEmitter: { fire: () => undefined },
  };
  const canvas = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const terminal = {
    cols: 80,
    buffer: { active: { length: 24 } },
    selectAll: () => undefined,
    selectionManager: manager,
    canvas,
  } as unknown as GhosttyTerminalType;
  return { terminal, manager };
}

describe("computeSelectAllRange", () => {
  test("covers the full buffer from origin to last cell", () => {
    expect(computeSelectAllRange(120, 40)).toEqual({
      start: { col: 0, absoluteRow: 0 },
      end: { col: 119, absoluteRow: 39 },
    });
  });

  test("returns null for invalid dimensions", () => {
    expect(computeSelectAllRange(0, 10)).toBeNull();
    expect(computeSelectAllRange(80, 0)).toBeNull();
    expect(computeSelectAllRange(-1, 5)).toBeNull();
  });
});

describe("installTerminalSelectionEnhancements", () => {
  test("silences the library's copy-on-selection-end clipboard write", async () => {
    const { terminal, manager } = createStubTerminal();
    const uninstall = installTerminalSelectionEnhancements(terminal);

    await manager.copyToClipboard("selected text");
    expect(manager.copied).toEqual([]);

    uninstall();
  });

  test("restores the library clipboard write on uninstall", async () => {
    const { terminal, manager } = createStubTerminal();
    installTerminalSelectionEnhancements(terminal)();

    await manager.copyToClipboard("selected text");
    expect(manager.copied).toEqual(["selected text"]);
  });

  test("routes manager.selectAll through the full-buffer selection", () => {
    const { terminal, manager } = createStubTerminal();
    const uninstall = installTerminalSelectionEnhancements(terminal);

    manager.selectAll();
    expect(manager.selectAllCalls).toBe(0);
    expect(manager.selectionStart).toEqual({ col: 0, absoluteRow: 0 });
    expect(manager.selectionEnd).toEqual({ col: 79, absoluteRow: 23 });

    uninstall();
    manager.selectAll();
    expect(manager.selectAllCalls).toBe(1);
  });
});

describe("handleTerminalSelectionShortcut", () => {
  function eventFor(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
      type: "keydown",
      key: "c",
      code: "KeyC",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      ...overrides,
    } as KeyboardEvent;
  }

  async function withClipboard(
    platform: string,
    run: (writes: string[]) => void | Promise<void>,
  ): Promise<void> {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const writes: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => writes.push(text) } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        eco: {
          platform,
          saveKeyboardShortcuts: async (bindings: ReturnType<typeof defaultShortcutBindings>) => ({
            bindings,
          }),
        },
      },
    });
    try {
      await run(writes);
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, "navigator");
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  }

  for (const platform of ["darwin", "win32", "linux"]) {
    test(`Ctrl+C copies the selection on ${platform} and passes through without one`, async () => {
      await withClipboard(platform, async (writes) => {
        let selected = true;
        const terminal = {
          hasSelection: () => selected,
          getSelection: () => (selected ? "selected terminal text" : ""),
        } as unknown as GhosttyTerminalType;
        const event = eventFor({ ctrlKey: true });

        expect(handleTerminalSelectionShortcut(terminal, event)).toBe(true);
        expect(writes).toEqual(["selected terminal text"]);

        selected = false;
        expect(handleTerminalSelectionShortcut(terminal, event)).toBe(false);
        expect(writes).toEqual(["selected terminal text"]);
      });
    });
  }

  test("Command+C copies on macOS and Ctrl+Shift+C remains available", async () => {
    await withClipboard("darwin", (writes) => {
      const terminal = {
        hasSelection: () => true,
        getSelection: () => "selected terminal text",
      } as unknown as GhosttyTerminalType;

      expect(handleTerminalSelectionShortcut(terminal, eventFor({ metaKey: true }))).toBe(true);
      expect(handleTerminalSelectionShortcut(terminal, eventFor({ ctrlKey: true, shiftKey: true }))).toBe(
        true,
      );
      expect(writes).toEqual(["selected terminal text", "selected terminal text"]);
    });
  });

  test("Ctrl+C still interrupts without a selection when configured as the terminal copy shortcut", async () => {
    await withClipboard("darwin", async (writes) => {
      const bindings = defaultShortcutBindings("darwin");
      await saveKeyboardShortcuts({ ...bindings, "terminal-copy": ["Control+C"] });
      try {
        const terminal = {
          hasSelection: () => false,
          getSelection: () => "",
        } as unknown as GhosttyTerminalType;

        expect(handleTerminalSelectionShortcut(terminal, eventFor({ ctrlKey: true }))).toBe(false);
        expect(writes).toEqual([]);
      } finally {
        await saveKeyboardShortcuts(bindings);
      }
    });
  });

  test("does not intercept unrelated, composing, or keyup events", async () => {
    await withClipboard("darwin", (writes) => {
      const terminal = {
        hasSelection: () => true,
        getSelection: () => "selected terminal text",
      } as unknown as GhosttyTerminalType;

      expect(handleTerminalSelectionShortcut(terminal, eventFor({ ctrlKey: true, altKey: true }))).toBe(
        false,
      );
      expect(handleTerminalSelectionShortcut(terminal, eventFor({ ctrlKey: true, isComposing: true }))).toBe(
        false,
      );
      expect(handleTerminalSelectionShortcut(terminal, eventFor({ ctrlKey: true, type: "keyup" }))).toBe(
        false,
      );
      expect(writes).toEqual([]);
    });
  });
});

describe("pasteClipboardIntoTerminal", () => {
  test("pastes clipboard text through the terminal (bracketed paste aware)", async () => {
    const pasted: string[] = [];
    const terminal = { paste: (text: string) => pasted.push(text) } as unknown as GhosttyTerminalType;

    const ok = await pasteClipboardIntoTerminal(terminal, async () => "echo hi");

    expect(ok).toBe(true);
    expect(pasted).toEqual(["echo hi"]);
  });

  test("does not touch the terminal when the clipboard is empty", async () => {
    const pasted: string[] = [];
    const terminal = { paste: (text: string) => pasted.push(text) } as unknown as GhosttyTerminalType;

    const ok = await pasteClipboardIntoTerminal(terminal, async () => "");

    expect(ok).toBe(false);
    expect(pasted).toEqual([]);
  });
});
