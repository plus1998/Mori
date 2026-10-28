import { shortcutMatches } from "./keyboard-shortcuts";
import type { Terminal as GhosttyTerminalType } from "ghostty-web";
import { copyTextToClipboard } from "./clipboard";

/** Absolute cell position in the combined scrollback + screen buffer. */
export interface TerminalCellPos {
  col: number;
  absoluteRow: number;
}

/** Runtime surface of ghostty-web SelectionManager used for selection enhancements. */
interface SelectionManagerRuntime {
  selectionStart: TerminalCellPos | null;
  selectionEnd: TerminalCellPos | null;
  isSelecting: boolean;
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

interface TerminalRuntime {
  selectionManager?: SelectionManagerRuntime;
  canvas?: HTMLCanvasElement;
}

export function computeSelectAllRange(
  cols: number,
  bufferLength: number,
): { start: TerminalCellPos; end: TerminalCellPos } | null {
  if (cols <= 0 || bufferLength <= 0) {
    return null;
  }
  return {
    start: { col: 0, absoluteRow: 0 },
    end: { col: cols - 1, absoluteRow: bufferLength - 1 },
  };
}

function asTerminalRuntime(terminal: GhosttyTerminalType): TerminalRuntime {
  return terminal as unknown as TerminalRuntime;
}

function getSelectionManager(terminal: GhosttyTerminalType): SelectionManagerRuntime | undefined {
  return asTerminalRuntime(terminal).selectionManager;
}

function getCanvas(terminal: GhosttyTerminalType): HTMLCanvasElement | undefined {
  return asTerminalRuntime(terminal).canvas;
}

function fireSelectionChanged(manager: SelectionManagerRuntime): void {
  manager.requestRender();
  manager.selectionChangedEmitter.fire();
}

/**
 * Select the entire scrollback + active screen (not only the viewport).
 * ghostty-web's built-in selectAll only covers the current viewport rows.
 */
export function selectAllTerminalText(terminal: GhosttyTerminalType): void {
  const manager = getSelectionManager(terminal);
  if (!manager) {
    terminal.selectAll();
    return;
  }

  // Prefer active buffer length so alternate-screen apps (vim/less) stay correct.
  const bufferLength = terminal.buffer.active.length;
  const range = computeSelectAllRange(terminal.cols, bufferLength);
  if (!range) {
    manager.clearSelection();
    return;
  }

  if (manager.hasSelection()) {
    manager.markCurrentSelectionDirty();
  }
  manager.selectionStart = range.start;
  manager.selectionEnd = range.end;
  manager.isSelecting = false;
  fireSelectionChanged(manager);
}

export async function copyTerminalSelection(terminal: GhosttyTerminalType): Promise<boolean> {
  const text = terminal.getSelection();
  if (!text) {
    return false;
  }
  return copyTextToClipboard(text);
}

/**
 * Paste clipboard text into the terminal.
 * `Terminal.paste` adds bracketed-paste markers when the running app asked for them.
 */
export async function pasteClipboardIntoTerminal(
  terminal: GhosttyTerminalType,
  readClipboardText: () => Promise<string>,
): Promise<boolean> {
  const text = await readClipboardText();
  if (!text) {
    return false;
  }
  terminal.paste(text);
  return true;
}

function resolveShiftClickAnchor(
  manager: SelectionManagerRuntime,
  terminal: GhosttyTerminalType,
): TerminalCellPos | null {
  if (manager.selectionStart) {
    return { ...manager.selectionStart };
  }

  const buffer = terminal.buffer.active;
  const absoluteRow = manager.viewportRowToAbsolute(buffer.cursorY);
  return {
    col: Math.max(0, Math.min(buffer.cursorX, Math.max(0, terminal.cols - 1))),
    absoluteRow,
  };
}

/**
 * Enhance ghostty-web selection:
 * - full-buffer selectAll
 * - Shift+click / Shift+drag to extend selection from the existing anchor (or cursor)
 * - no implicit clipboard write on selection end (copy needs an explicit gesture)
 */
export function installTerminalSelectionEnhancements(terminal: GhosttyTerminalType): () => void {
  const manager = getSelectionManager(terminal);
  const canvas = getCanvas(terminal);
  if (!manager || !canvas) {
    return () => undefined;
  }

  const originalSelectAll = manager.selectAll.bind(manager);
  manager.selectAll = () => {
    selectAllTerminalText(terminal);
  };

  // ghostty-web copies to the system clipboard on every mouseup / dblclick that ends a
  // selection. Selecting is a read gesture, so silence the implicit write and keep the
  // highlight: Eco copies only through the terminal context menu or Ctrl/Cmd+C.
  const originalCopyToClipboard = manager.copyToClipboard;
  manager.copyToClipboard = async () => undefined;

  const onMouseDownCapture = (event: MouseEvent) => {
    if (event.button !== 0 || !event.shiftKey) {
      return;
    }

    // Let scrollbar / non-primary interactions fall through.
    const target = event.target;
    if (!(target instanceof Node) || !canvas.contains(target)) {
      return;
    }

    const anchor = resolveShiftClickAnchor(manager, terminal);
    if (!anchor) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const cell = manager.pixelToCell(event.offsetX, event.offsetY);
    const absoluteRow = manager.viewportRowToAbsolute(cell.row);
    if (manager.hasSelection()) {
      manager.markCurrentSelectionDirty();
    }

    manager.selectionStart = anchor;
    manager.selectionEnd = { col: cell.col, absoluteRow };
    manager.isSelecting = true;
    fireSelectionChanged(manager);
    terminal.focus();
  };

  canvas.addEventListener("mousedown", onMouseDownCapture, true);

  return () => {
    canvas.removeEventListener("mousedown", onMouseDownCapture, true);
    manager.selectAll = originalSelectAll;
    manager.copyToClipboard = originalCopyToClipboard;
  };
}

/** Keyboard handling for terminal copy / select-all chords. Returns true to swallow the event. */
export function handleTerminalSelectionShortcut(
  terminal: GhosttyTerminalType,
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown" || event.isComposing) {
    return false;
  }

  if (shortcutMatches(event, "selectAll")) {
    selectAllTerminalText(terminal);
    return true;
  }
  if (shortcutMatches(event, "terminal-copy")) {
    void copyTerminalSelection(terminal);
    return true;
  }
  if (shortcutMatches(event, "copy")) {
    // Preserve a bare Ctrl+C as a PTY interrupt when nothing is selected.
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c" && !terminal.hasSelection()) return false;
    void copyTerminalSelection(terminal);
    return true;
  }

  return false;
}
