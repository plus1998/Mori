import { shortcutMatches } from "./keyboard-shortcuts";
import type {
  FitAddon,
  Ghostty,
  GhosttyCell,
  Terminal as GhosttyTerminalType,
  ITheme,
  RGB,
} from "ghostty-web";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalStreamEvent } from "../shared/ipc";
import { i18n } from "./i18n";
import { TerminalContextMenu, type TerminalContextMenuAnchor } from "./TerminalContextMenu";
import { installTerminalLinkHandling } from "./terminal-links";
import {
  copyTerminalSelection,
  handleTerminalSelectionShortcut,
  installTerminalSelectionEnhancements,
  pasteClipboardIntoTerminal,
  selectAllTerminalText,
} from "./terminal-selection";
import {
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  TYPOGRAPHY_CHANGE_EVENT,
  type TypographyPreferences,
} from "./typography-preferences";

interface GhosttyRuntime {
  mod: typeof import("ghostty-web");
  ghostty: Ghostty;
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

let sharedGhostty: Promise<GhosttyRuntime> | undefined;
let ghosttyRetainCount = 0;
let ghosttyReleaseTimer: ReturnType<typeof setTimeout> | undefined;

const GHOSTTY_RELEASE_DELAY_MS = 30_000;

function loadGhosttyRuntime(): Promise<GhosttyRuntime> {
  if (!sharedGhostty) {
    sharedGhostty = import("ghostty-web")
      .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
      .catch((error) => {
        sharedGhostty = undefined;
        throw error;
      });
  }
  return sharedGhostty;
}

/** Keep the shared WASM runtime warm while any GhosttyTerminal is mounted. */
export function retainGhosttyRuntime(): void {
  ghosttyRetainCount += 1;
  if (ghosttyReleaseTimer) {
    clearTimeout(ghosttyReleaseTimer);
    ghosttyReleaseTimer = undefined;
  }
}

/**
 * Drop the shared runtime after the last terminal unmounts (delayed) so reopen
 * is still fast, but idle sessions can release the WASM heap.
 */
export function releaseGhosttyRuntime(): void {
  ghosttyRetainCount = Math.max(0, ghosttyRetainCount - 1);
  if (ghosttyRetainCount > 0) {
    return;
  }
  if (ghosttyReleaseTimer) {
    clearTimeout(ghosttyReleaseTimer);
  }
  ghosttyReleaseTimer = setTimeout(() => {
    ghosttyReleaseTimer = undefined;
    if (ghosttyRetainCount === 0) {
      sharedGhostty = undefined;
    }
  }, GHOSTTY_RELEASE_DELAY_MS);
}

function readCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readTerminalFontSize(): number {
  const value = Number.parseFloat(
    readCssVar("--code-font-size", String(DEFAULT_TYPOGRAPHY_PREFERENCES.codeFontSize)),
  );
  return Number.isFinite(value) ? value : DEFAULT_TYPOGRAPHY_PREFERENCES.codeFontSize;
}

function readTerminalTheme(): ITheme {
  const isLight = document.documentElement.dataset.theme === "light";
  const background = readCssVar("--terminal-bg", isLight ? "#f7f7f8" : "#171717");
  const foreground = readCssVar("--terminal-fg", isLight ? "#1d1d1f" : "#f2f2f2");
  const selectionBackground = readCssVar(
    "--terminal-selection-bg",
    isLight ? "rgba(0, 122, 255, 0.22)" : "rgba(59, 130, 246, 0.35)",
  );

  if (isLight) {
    return {
      background,
      foreground,
      cursor: readCssVar("--terminal-cursor", foreground),
      cursorAccent: background,
      selectionBackground,
      selectionForeground: foreground,
      black: "#1d1d1f",
      red: "#d70015",
      green: "#248a3d",
      yellow: "#b25000",
      blue: "#0040dd",
      magenta: "#8944ab",
      cyan: "#007787",
      white: "#6e6e73",
      brightBlack: "#6e6e73",
      brightRed: "#ff3b30",
      brightGreen: "#34c759",
      brightYellow: "#ff9500",
      brightBlue: "#007aff",
      brightMagenta: "#af52de",
      brightCyan: "#32ade6",
      brightWhite: "#1d1d1f",
    };
  }

  return {
    background,
    foreground,
    cursor: readCssVar("--terminal-cursor", foreground),
    cursorAccent: background,
    selectionBackground,
    selectionForeground: foreground,
    black: "#1d1d1f",
    red: "#ff453a",
    green: "#32d74b",
    yellow: "#ffd60a",
    blue: "#0a84ff",
    magenta: "#bf5af2",
    cyan: "#64d2ff",
    white: "#f2f2f2",
    brightBlack: "#8e8e93",
    brightRed: "#ff6961",
    brightGreen: "#30db5b",
    brightYellow: "#ffd426",
    brightBlue: "#409cff",
    brightMagenta: "#da8fff",
    brightCyan: "#70d7ff",
    brightWhite: "#ffffff",
  };
}

interface TerminalThemeState {
  defaultBackground: RGB;
  defaultForeground: RGB;
  background: RGB | undefined;
  foreground: RGB | undefined;
}

function parseCssColor(value: string): RGB | undefined {
  const normalized = value.trim();
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? hex.replace(/./g, (digit) => `${digit}${digit}`) : hex;
    const parsed = Number.parseInt(expanded, 16);
    return {
      r: (parsed >> 16) & 0xff,
      g: (parsed >> 8) & 0xff,
      b: parsed & 0xff,
    };
  }
  const rgb = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) {
    return undefined;
  }
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
  };
}

function hasRgb(cell: GhosttyCell, prefix: "bg" | "fg", color: RGB): boolean {
  return (
    cell[`${prefix}_r`] === color.r && cell[`${prefix}_g`] === color.g && cell[`${prefix}_b`] === color.b
  );
}

function remapDefaultColors(cells: GhosttyCell[] | null, state: TerminalThemeState): GhosttyCell[] | null {
  if (!cells) {
    return null;
  }

  const nextBackground = state.background;
  const nextForeground = state.foreground;
  if (
    (!nextBackground ||
      (nextBackground.r === state.defaultBackground.r &&
        nextBackground.g === state.defaultBackground.g &&
        nextBackground.b === state.defaultBackground.b)) &&
    (!nextForeground ||
      (nextForeground.r === state.defaultForeground.r &&
        nextForeground.g === state.defaultForeground.g &&
        nextForeground.b === state.defaultForeground.b))
  ) {
    return cells;
  }

  let changed = false;
  const remapped = cells.map((cell) => {
    let next = cell;
    if (nextBackground && hasRgb(cell, "bg", state.defaultBackground)) {
      next = { ...next, bg_r: nextBackground.r, bg_g: nextBackground.g, bg_b: nextBackground.b };
      changed = true;
    }
    if (nextForeground && hasRgb(cell, "fg", state.defaultForeground)) {
      next = { ...next, fg_r: nextForeground.r, fg_g: nextForeground.g, fg_b: nextForeground.b };
      changed = true;
    }
    return next;
  });
  return changed ? remapped : cells;
}

function installTerminalThemeAdapter(terminal: GhosttyTerminalType, state: TerminalThemeState): () => void {
  const wasmTerm = terminal.wasmTerm;
  if (!wasmTerm) {
    return () => {};
  }

  const originalGetLine = wasmTerm.getLine.bind(wasmTerm);
  const originalGetScrollbackLine = wasmTerm.getScrollbackLine.bind(wasmTerm);
  wasmTerm.getLine = (row) => remapDefaultColors(originalGetLine(row), state);
  wasmTerm.getScrollbackLine = (offset) => remapDefaultColors(originalGetScrollbackLine(offset), state);

  return () => {
    wasmTerm.getLine = originalGetLine;
    wasmTerm.getScrollbackLine = originalGetScrollbackLine;
  };
}

function applyTerminalTheme(terminal: GhosttyTerminalType, state: TerminalThemeState): void {
  const theme = readTerminalTheme();
  const renderer = terminal.renderer;
  const wasmTerm = terminal.wasmTerm;

  // ghostty-web currently warns that changing options.theme after open() is not
  // fully supported. Update the live canvas renderer directly and force a full
  // paint so existing terminal cells get the new background immediately.
  if (renderer && wasmTerm) {
    state.background = parseCssColor(theme.background ?? "");
    state.foreground = parseCssColor(theme.foreground ?? "");
    renderer.setTheme(theme);
    renderer.clear();
    renderer.render(wasmTerm, true, terminal.viewportY, terminal);
  }
}

function isToggleTerminalShortcut(event: KeyboardEvent): boolean {
  return shortcutMatches(event, "toggle-bottom-panel");
}

function mountHasLayout(element: HTMLElement): boolean {
  return element.clientWidth > 0 && element.clientHeight > 0;
}

async function fitWhenLayoutReady(
  mount: HTMLElement,
  fit: FitAddon,
  terminal: GhosttyTerminalType,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    fit.fit();
    if (mountHasLayout(mount) && terminal.cols > 0 && terminal.rows > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
  fit.fit();
}

interface GhosttyTerminalProps {
  sessionId: string | null;
  active?: boolean;
  initialOutput?: string;
  onDimensionsReady?: (dimensions: TerminalDimensions) => void;
  onExit?: (exitCode: number) => void;
  /** Fired for local keystrokes / paste; not for remote program output. */
  onUserInput?: () => void;
}

export function GhosttyTerminal({
  sessionId,
  active = true,
  initialOutput,
  onDimensionsReady,
  onExit,
  onUserInput,
}: GhosttyTerminalProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef(sessionId);
  const activeRef = useRef(active);
  const onDimensionsReadyRef = useRef(onDimensionsReady);
  const onExitRef = useRef(onExit);
  const onUserInputRef = useRef(onUserInput);
  const termRef = useRef<GhosttyTerminalType | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const dimensionsReadyRef = useRef(false);
  const initialResizeSyncedRef = useRef(false);
  const [terminalEpoch, setTerminalEpoch] = useState(0);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuAnchor | undefined>(undefined);

  sessionIdRef.current = sessionId;
  activeRef.current = active;
  onDimensionsReadyRef.current = onDimensionsReady;
  onExitRef.current = onExit;
  onUserInputRef.current = onUserInput;

  useEffect(() => {
    if (sessionId) {
      return;
    }
    dimensionsReadyRef.current = false;
    initialResizeSyncedRef.current = false;
    const terminal = termRef.current;
    if (!terminal || terminal.cols <= 0 || terminal.rows <= 0) {
      return;
    }
    dimensionsReadyRef.current = true;
    onDimensionsReadyRef.current?.({
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }, [sessionId]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !window.eco) {
      return undefined;
    }

    retainGhosttyRuntime();
    let disposed = false;
    let resizeTimer: number | undefined;
    let fitFrame: number | undefined;
    const cleanups: Array<() => void> = [];

    const notifyDimensionsReady = (terminal: GhosttyTerminalType) => {
      if (dimensionsReadyRef.current || sessionIdRef.current) {
        return;
      }
      if (terminal.cols <= 0 || terminal.rows <= 0) {
        return;
      }
      dimensionsReadyRef.current = true;
      onDimensionsReadyRef.current?.({
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const syncPtySize = (cols: number, rows: number, immediate = false) => {
      if (!sessionIdRef.current || !window.eco) {
        return;
      }
      if (immediate) {
        void window.eco
          .resizeTerminal({ sessionId: sessionIdRef.current, cols, rows })
          .catch(() => undefined);
        return;
      }
      if (resizeTimer !== undefined) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined;
        if (disposed || !sessionIdRef.current || !window.eco) {
          return;
        }
        void window.eco
          .resizeTerminal({ sessionId: sessionIdRef.current, cols, rows })
          .catch(() => undefined);
      }, 100);
    };

    const run = async () => {
      const { mod, ghostty } = await loadGhosttyRuntime();
      if (disposed) {
        return;
      }

      const initialTheme = readTerminalTheme();
      const terminal = new mod.Terminal({
        ghostty,
        cursorBlink: true,
        scrollback: 10_000,
        fontSize: readTerminalFontSize(),
        fontFamily: readCssVar(
          "--font-mono",
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        ),
        theme: initialTheme,
      });
      termRef.current = terminal;

      const fit = new mod.FitAddon();
      fitRef.current = fit;
      terminal.loadAddon(fit);

      terminal.attachCustomKeyEventHandler((event) => {
        if (isToggleTerminalShortcut(event)) {
          return true;
        }
        if (handleTerminalSelectionShortcut(terminal, event)) {
          return true;
        }
        return false;
      });

      terminal.open(mount);
      cleanups.push(installTerminalSelectionEnhancements(terminal));
      cleanups.push(installTerminalLinkHandling(terminal));

      const wasmTerm = terminal.wasmTerm;
      const themeState = wasmTerm
        ? {
            defaultBackground: wasmTerm.getColors().background,
            defaultForeground: wasmTerm.getColors().foreground,
            background: parseCssColor(initialTheme.background ?? ""),
            foreground: parseCssColor(initialTheme.foreground ?? ""),
          }
        : undefined;
      if (themeState) {
        cleanups.push(installTerminalThemeAdapter(terminal, themeState));
        // Sync once after opening in case the system theme changed while the
        // Ghostty WASM runtime was loading.
        applyTerminalTheme(terminal, themeState);
      }

      // Right-click opens Eco's own menu. Capture phase on the mount keeps ghostty-web's
      // contextmenu handler (it parks the selection in its hidden textarea for the browser
      // menu) out of the way, so the menu owns copy / paste / select-all.
      const onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: terminal.hasSelection(),
        });
      };
      mount.addEventListener("contextmenu", onContextMenu, true);
      cleanups.push(() => mount.removeEventListener("contextmenu", onContextMenu, true));

      const themeObserver = new MutationObserver(() => {
        if (!disposed && termRef.current && themeState) {
          applyTerminalTheme(termRef.current, themeState);
        }
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      cleanups.push(() => themeObserver.disconnect());

      const scheduleFit = () => {
        if (disposed || !fitRef.current) {
          return;
        }
        if (fitFrame !== undefined) {
          return;
        }
        fitFrame = window.requestAnimationFrame(() => {
          fitFrame = undefined;
          if (disposed || !fitRef.current || !termRef.current) {
            return;
          }
          fitRef.current.fit();
        });
      };

      const onResize = terminal.onResize(({ cols, rows }) => {
        const immediate = !initialResizeSyncedRef.current;
        if (immediate) {
          initialResizeSyncedRef.current = true;
        }
        syncPtySize(cols, rows, immediate);
      });
      cleanups.push(() => onResize.dispose());

      const handleWindowResize = () => scheduleFit();
      window.addEventListener("resize", handleWindowResize);
      cleanups.push(() => window.removeEventListener("resize", handleWindowResize));

      const handleTypographyChange = (event: Event) => {
        const preferences = (event as CustomEvent<TypographyPreferences>).detail;
        if (!preferences || disposed || !termRef.current) {
          return;
        }
        termRef.current.options.fontSize = preferences.codeFontSize;
        scheduleFit();
      };
      window.addEventListener(TYPOGRAPHY_CHANGE_EVENT, handleTypographyChange);
      cleanups.push(() => window.removeEventListener(TYPOGRAPHY_CHANGE_EVENT, handleTypographyChange));

      if (document.fonts) {
        await document.fonts.ready;
      }
      if (disposed) {
        return;
      }

      await fitWhenLayoutReady(mount, fit, terminal);
      if (disposed) {
        return;
      }

      notifyDimensionsReady(terminal);
      if (sessionIdRef.current) {
        syncPtySize(terminal.cols, terminal.rows, true);
      }

      fit.observeResize();
      cleanups.push(() => fit.dispose());

      if (activeRef.current) {
        terminal.focus();
      }

      setTerminalEpoch((epoch) => epoch + 1);
    };

    void run().catch((error) => {
      if (disposed || !mount) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      mount.textContent = i18n.t("terminal.initFailed", { detail: message });
      mount.style.color = "var(--terminal-fg, var(--text-primary))";
    });

    return () => {
      disposed = true;
      if (fitFrame !== undefined) {
        window.cancelAnimationFrame(fitFrame);
      }
      if (resizeTimer !== undefined) {
        window.clearTimeout(resizeTimer);
      }
      for (const cleanup of cleanups.reverse()) {
        cleanup();
      }
      termRef.current?.dispose();
      termRef.current = undefined;
      fitRef.current = undefined;
      releaseGhosttyRuntime();
    };
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(undefined);
    termRef.current?.focus();
  }, []);

  const handleContextMenuCopy = useCallback(() => {
    const terminal = termRef.current;
    if (terminal) {
      void copyTerminalSelection(terminal);
    }
    closeContextMenu();
  }, [closeContextMenu]);

  const handleContextMenuPaste = useCallback(() => {
    const terminal = termRef.current;
    const eco = window.eco;
    if (terminal && eco) {
      void pasteClipboardIntoTerminal(terminal, () => eco.readClipboardText()).catch((error) => {
        console.error("[eco] failed to paste into the terminal:", error);
      });
    }
    closeContextMenu();
  }, [closeContextMenu]);

  const handleContextMenuSelectAll = useCallback(() => {
    const terminal = termRef.current;
    if (terminal) {
      selectAllTerminalText(terminal);
    }
    closeContextMenu();
  }, [closeContextMenu]);

  useEffect(() => {
    const terminal = termRef.current;
    const eco = window.eco;
    if (!terminal || !sessionId || !eco) {
      return undefined;
    }

    terminal.clear();
    if (initialOutput) {
      terminal.write(initialOutput);
    }
    initialResizeSyncedRef.current = false;
    void eco.resizeTerminal({ sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    initialResizeSyncedRef.current = true;

    const onData = terminal.onData((data) => {
      onUserInputRef.current?.();
      void eco.writeTerminalInput({ sessionId, data }).catch(() => undefined);
    });

    // Batch writes onto animation frames so rapid IPC output lands as fewer
    // Ghostty paints (pairs with main-process coalesce).
    let writeBuffer = "";
    let writeFrame: number | undefined;
    const flushWriteBuffer = () => {
      writeFrame = undefined;
      if (!writeBuffer) {
        return;
      }
      const chunk = writeBuffer;
      writeBuffer = "";
      terminal.write(chunk);
    };
    const queueWrite = (data: string) => {
      writeBuffer += data;
      if (writeFrame !== undefined) {
        return;
      }
      writeFrame = window.requestAnimationFrame(flushWriteBuffer);
    };

    const unsubscribe = eco.onTerminalEvent((event: TerminalStreamEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "output") {
        queueWrite(event.data);
        return;
      }
      if (event.type === "error") {
        flushWriteBuffer();
        terminal.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
        return;
      }
      if (event.type === "exit") {
        flushWriteBuffer();
        onExitRef.current?.(event.exitCode);
      }
    });

    return () => {
      if (writeFrame !== undefined) {
        window.cancelAnimationFrame(writeFrame);
        writeFrame = undefined;
      }
      if (writeBuffer) {
        terminal.write(writeBuffer);
        writeBuffer = "";
      }
      onData.dispose();
      unsubscribe();
    };
  }, [initialOutput, sessionId, terminalEpoch]);

  useEffect(() => {
    const terminal = termRef.current;
    const mount = mountRef.current;
    if (!terminal || !mount) {
      return undefined;
    }
    if (!active) {
      terminal.blur();
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      terminal.focus();
    };
    mount.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      mount.removeEventListener("pointerdown", onPointerDown);
    };
  }, [active]);

  return (
    <div className="ghostty-terminal-host" data-component="terminal">
      <div ref={mountRef} className="ghostty-terminal-mount" />
      {contextMenu ? (
        <TerminalContextMenu
          anchor={contextMenu}
          hasSelection={contextMenu.hasSelection}
          onCopy={handleContextMenuCopy}
          onPaste={handleContextMenuPaste}
          onSelectAll={handleContextMenuSelectAll}
          onClose={closeContextMenu}
        />
      ) : null}
    </div>
  );
}
