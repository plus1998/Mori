import type { CSSProperties } from "react";

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 8;
const MIN_FLOATING_HEIGHT = 48;

export interface ComposerFloatingOptions {
  width?: number;
  minHeight?: number;
  margin?: number;
  gap?: number;
  prefer?: "above" | "below" | "auto";
  align?: "center" | "start" | "end";
  /** Fixed popover height, clamped to available viewport space. */
  fixedHeight?: number;
}

export interface ComposerFloatingViewport {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function readWindowWidth(): number {
  return typeof window !== "undefined" ? window.innerWidth : 0;
}

function readWindowHeight(): number {
  return typeof window !== "undefined" ? window.innerHeight : 0;
}

export function composerFloatingViewport(margin = DEFAULT_MARGIN): ComposerFloatingViewport {
  const windowWidth = readWindowWidth();
  const windowHeight = readWindowHeight();
  const left = margin;
  const right = Math.max(margin, windowWidth - margin);
  const top = margin;
  const bottom = Math.max(top, windowHeight - margin);

  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** viewportWidth arg for cascade placement helpers (right edge + margin). */
export function composerFloatingPlacementViewportWidth(margin = DEFAULT_MARGIN): number {
  return composerFloatingViewport(margin).right + margin;
}

export function clampComposerFloatingLeft(rawLeft: number, width: number, margin = DEFAULT_MARGIN): number {
  const viewport = composerFloatingViewport(margin);
  return clamp(rawLeft, viewport.left, viewport.right - width);
}

export function composerFloatingAvailableWidth(margin = DEFAULT_MARGIN, minWidth = 160): number {
  return Math.max(minWidth, composerFloatingViewport(margin).width);
}

export function composerFloatingStyleForAnchor(
  anchor: HTMLElement,
  options: ComposerFloatingOptions = {},
): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const margin = options.margin ?? DEFAULT_MARGIN;
  const gap = options.gap ?? DEFAULT_GAP;
  const viewport = composerFloatingViewport(margin);
  const preferredWidth = options.width ?? 280;
  const width = Math.min(preferredWidth, Math.max(160, viewport.width));
  const rawLeft =
    options.align === "start"
      ? rect.left
      : options.align === "end"
        ? rect.right - width
        : rect.left + rect.width / 2 - width / 2;
  const left = clamp(rawLeft, viewport.left, viewport.right - width);
  const windowHeight = readWindowHeight();
  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = windowHeight - rect.bottom - margin - gap;
  const minHeight = options.minHeight ?? 96;
  const prefer = options.prefer ?? "auto";
  const placeAbove =
    prefer === "above"
      ? spaceAbove >= minHeight || spaceAbove >= spaceBelow
      : prefer === "below"
        ? spaceBelow < minHeight && spaceAbove > spaceBelow
        : spaceBelow < minHeight && spaceAbove > spaceBelow;
  const availableSpace = Math.max(MIN_FLOATING_HEIGHT, Math.floor(placeAbove ? spaceAbove : spaceBelow));
  const fixedHeight =
    options.fixedHeight !== undefined
      ? Math.min(Math.max(options.fixedHeight, MIN_FLOATING_HEIGHT), availableSpace)
      : undefined;

  return {
    position: "fixed",
    left,
    width,
    maxWidth: width,
    boxSizing: "border-box",
    maxHeight: fixedHeight ?? availableSpace,
    ...(fixedHeight !== undefined ? { height: fixedHeight } : {}),
    zIndex: 10000,
    ...(placeAbove ? { bottom: windowHeight - rect.top + gap } : { top: rect.bottom + gap }),
  };
}

/** Reposition open composer popovers when the window resizes. */
export function observeComposerFloatingViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  let frame = 0;
  const schedule = () => {
    if (frame) {
      cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      onChange();
    });
  };

  window.addEventListener("resize", schedule);
  return () => {
    if (frame) {
      cancelAnimationFrame(frame);
    }
    window.removeEventListener("resize", schedule);
  };
}
