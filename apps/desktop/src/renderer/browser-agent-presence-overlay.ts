import type { BrowserAgentPresenceEvent } from "../shared/browser-agent-presence";
import { resolveBrowserWebviewHostSlot } from "./browser-webview-layout";

const CURSOR_CLASS = "browser-agent-cursor";
const RIPPLE_CLASS = "browser-agent-click-ripple";
const STRIP_CLASS = "browser-agent-light-strip";
const HALO_CLASS = "browser-agent-halo";
/** Legacy heavy mist layer — removed from the DOM if a previous version left one. */
const LEGACY_MIST_CLASS = "browser-agent-mist";
const ACTIVE_CLASS = "is-agent-active";
const CLICKING_CLASS = "is-agent-clicking";
const PULSE_CLASS = "is-breath-pulse";
const MOVE_MS = 320;
const DRAG_MOVE_MS = 90;
const PULSE_MS = 920;
/** Bump when the overlay DOM structure changes to force a rebuild. */
const OVERLAY_VERSION = "8";

type CursorState = {
  x: number;
  y: number;
  visible: boolean;
  dragging: boolean;
};

const cursorByBrowserId = new Map<string, CursorState>();
const moveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function findOverlay(browserId: string): HTMLDivElement | null {
  const slot = resolveBrowserWebviewHostSlot(browserId);
  if (!slot) {
    return null;
  }
  return slot.querySelector<HTMLDivElement>(".browser-panel-overlay-host");
}

function ensureHalo(overlay: HTMLDivElement): HTMLDivElement {
  let halo = overlay.querySelector<HTMLDivElement>(`.${HALO_CLASS}`);
  if (halo?.dataset.haloVersion === OVERLAY_VERSION) {
    return halo;
  }
  halo?.remove();
  halo = document.createElement("div");
  halo.className = HALO_CLASS;
  halo.dataset.haloVersion = OVERLAY_VERSION;
  halo.setAttribute("aria-hidden", "true");
  overlay.prepend(halo);
  return halo;
}

function ensureLightStrip(overlay: HTMLDivElement): HTMLDivElement {
  let strip = overlay.querySelector<HTMLDivElement>(`.${STRIP_CLASS}`);
  if (strip?.dataset.stripVersion === OVERLAY_VERSION) {
    return strip;
  }
  strip?.remove();
  strip = document.createElement("div");
  strip.className = STRIP_CLASS;
  strip.dataset.stripVersion = OVERLAY_VERSION;
  strip.setAttribute("aria-hidden", "true");
  overlay.append(strip);
  return strip;
}

function ensureCursor(overlay: HTMLDivElement): HTMLDivElement {
  let cursor = overlay.querySelector<HTMLDivElement>(`.${CURSOR_CLASS}`);
  if (cursor?.dataset.cursorVersion === OVERLAY_VERSION) {
    return cursor;
  }
  cursor?.remove();
  cursor = document.createElement("div");
  cursor.className = CURSOR_CLASS;
  cursor.dataset.cursorVersion = OVERLAY_VERSION;
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML = CURSOR_SVG;
  overlay.append(cursor);
  return cursor;
}

function ensureRipple(overlay: HTMLDivElement): HTMLDivElement {
  let ripple = overlay.querySelector<HTMLDivElement>(`.${RIPPLE_CLASS}`);
  if (ripple) {
    return ripple;
  }
  ripple = document.createElement("div");
  ripple.className = RIPPLE_CLASS;
  ripple.setAttribute("aria-hidden", "true");
  overlay.append(ripple);
  return ripple;
}

/** One-shot, restartable breath pulse tied to each Agent action. */
function triggerBreathPulse(overlay: HTMLDivElement, browserId: string): void {
  overlay.classList.remove(PULSE_CLASS);
  void overlay.offsetWidth;
  overlay.classList.add(PULSE_CLASS);
  const prev = pulseTimers.get(browserId);
  if (prev) {
    clearTimeout(prev);
  }
  pulseTimers.set(
    browserId,
    setTimeout(() => {
      overlay.classList.remove(PULSE_CLASS);
      pulseTimers.delete(browserId);
    }, PULSE_MS),
  );
}

function defaultCursorOrigin(overlay: HTMLDivElement): { x: number; y: number } {
  const w = overlay.clientWidth || 400;
  const h = overlay.clientHeight || 300;
  return { x: w * 0.18, y: h * 0.22 };
}

function setCursorPosition(
  cursor: HTMLDivElement,
  x: number,
  y: number,
  animate: boolean,
  durationMs = MOVE_MS,
): void {
  if (!animate) {
    cursor.style.transition = "none";
  } else {
    cursor.style.transition = `transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
  }
  cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  if (!animate) {
    void cursor.offsetWidth;
    cursor.style.transition = `transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
  }
}

function applyActive(browserId: string, options?: { pulse?: boolean }): void {
  const overlay = findOverlay(browserId);
  if (!overlay) {
    return;
  }
  overlay.classList.add(ACTIVE_CLASS);
  // Drop the legacy heavy mist layer if an older overlay version left one.
  overlay.querySelector(`.${LEGACY_MIST_CLASS}`)?.remove();
  ensureHalo(overlay);
  ensureLightStrip(overlay);
  const cursor = ensureCursor(overlay);
  ensureRipple(overlay);
  if (options?.pulse !== false) {
    triggerBreathPulse(overlay, browserId);
  }
  let state = cursorByBrowserId.get(browserId);
  if (!state) {
    const origin = defaultCursorOrigin(overlay);
    state = { x: origin.x, y: origin.y, visible: true, dragging: false };
    cursorByBrowserId.set(browserId, state);
    setCursorPosition(cursor, state.x, state.y, false);
  }
  cursor.classList.add("is-visible");
}

function applyIdle(browserId: string): void {
  const overlay = findOverlay(browserId);
  if (overlay) {
    overlay.classList.remove(ACTIVE_CLASS, CLICKING_CLASS, PULSE_CLASS);
    const cursor = overlay.querySelector<HTMLDivElement>(`.${CURSOR_CLASS}`);
    cursor?.classList.remove("is-visible", "is-pressed", "is-click-pop");
    overlay.querySelector(`.${RIPPLE_CLASS}`)?.classList.remove("is-active");
  }
  const timer = moveTimers.get(browserId);
  if (timer) {
    clearTimeout(timer);
    moveTimers.delete(browserId);
  }
  const pulse = pulseTimers.get(browserId);
  if (pulse) {
    clearTimeout(pulse);
    pulseTimers.delete(browserId);
  }
  cursorByBrowserId.delete(browserId);
}

function applyClick(browserId: string, x: number, y: number): void {
  applyActive(browserId);
  const overlay = findOverlay(browserId);
  if (!overlay) {
    return;
  }
  const cursor = ensureCursor(overlay);
  const ripple = ensureRipple(overlay);
  let state = cursorByBrowserId.get(browserId);
  if (!state) {
    const origin = defaultCursorOrigin(overlay);
    state = { x: origin.x, y: origin.y, visible: true, dragging: false };
    setCursorPosition(cursor, state.x, state.y, false);
  }
  cursor.classList.add("is-visible");
  cursor.classList.remove("is-pressed", "is-click-pop");
  overlay.classList.add(CLICKING_CLASS);

  const existing = moveTimers.get(browserId);
  if (existing) {
    clearTimeout(existing);
  }

  setCursorPosition(cursor, x, y, true);
  cursorByBrowserId.set(browserId, { x, y, visible: true, dragging: true });

  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  ripple.classList.remove("is-active");
  void ripple.offsetWidth;

  moveTimers.set(
    browserId,
    setTimeout(() => {
      moveTimers.delete(browserId);
      // Pop: enlarge then shrink when the click lands.
      cursor.classList.remove("is-click-pop");
      void cursor.offsetWidth;
      cursor.classList.add("is-click-pop");
      ripple.classList.add("is-active");
      overlay.classList.remove(CLICKING_CLASS);
      moveTimers.set(
        browserId,
        setTimeout(() => {
          moveTimers.delete(browserId);
          cursor.classList.remove("is-click-pop");
          cursor.classList.add("is-pressed");
        }, 420),
      );
    }, MOVE_MS),
  );
}

function applyMove(browserId: string, x: number, y: number, dragging: boolean): void {
  // Drag trails update often — skip breath pulse so the rim doesn't strobe.
  applyActive(browserId, { pulse: false });
  const overlay = findOverlay(browserId);
  if (!overlay) {
    return;
  }
  const cursor = ensureCursor(overlay);
  const state = cursorByBrowserId.get(browserId);
  if (!state) {
    setCursorPosition(cursor, x, y, false);
  } else {
    setCursorPosition(cursor, x, y, true, dragging ? DRAG_MOVE_MS : MOVE_MS);
  }
  cursor.classList.add("is-visible");
  if (dragging) {
    cursor.classList.add("is-pressed");
  }
  cursorByBrowserId.set(browserId, { x, y, visible: true, dragging });
}

function applyRelease(browserId: string, x: number, y: number): void {
  applyActive(browserId);
  const overlay = findOverlay(browserId);
  if (!overlay) {
    return;
  }
  const cursor = ensureCursor(overlay);
  const ripple = ensureRipple(overlay);
  setCursorPosition(cursor, x, y, true, DRAG_MOVE_MS);
  cursor.classList.add("is-visible");
  cursor.classList.remove("is-click-pop");
  cursor.classList.add("is-pressed");
  cursorByBrowserId.set(browserId, { x, y, visible: true, dragging: false });

  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  ripple.classList.remove("is-active");
  void ripple.offsetWidth;
  ripple.classList.add("is-active");

  const existing = moveTimers.get(browserId);
  if (existing) {
    clearTimeout(existing);
  }
  moveTimers.set(
    browserId,
    setTimeout(() => {
      moveTimers.delete(browserId);
      cursor.classList.remove("is-pressed");
      overlay.classList.remove(CLICKING_CLASS);
    }, 160),
  );
}

export function applyBrowserAgentPresenceEvent(event: BrowserAgentPresenceEvent): void {
  if (typeof document === "undefined") {
    return;
  }
  switch (event.type) {
    case "active":
      applyActive(event.browserId);
      return;
    case "click":
      applyClick(event.browserId, event.x, event.y);
      return;
    case "move":
      applyMove(event.browserId, event.x, event.y, event.dragging);
      return;
    case "release":
      applyRelease(event.browserId, event.x, event.y);
      return;
    case "idle":
      applyIdle(event.browserId);
      return;
  }
}

/** Start listening for Agent presence IPC (idempotent). */
export function installBrowserAgentPresenceOverlay(): () => void {
  if (typeof window === "undefined" || !window.eco?.onBrowserAgentPresence) {
    return () => {};
  }
  const syncPageVisibility = () => {
    document.documentElement.toggleAttribute("data-browser-agent-page-hidden", document.hidden);
  };
  syncPageVisibility();
  document.addEventListener("visibilitychange", syncPageVisibility);
  const unsubscribe = window.eco.onBrowserAgentPresence((event) => {
    applyBrowserAgentPresenceEvent(event);
  });
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", syncPageVisibility);
    document.documentElement.removeAttribute("data-browser-agent-page-hidden");
  };
}

/** Rainbow arrow pointer (hotspot ~1,1). */
const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none">
  <defs>
    <linearGradient id="browser-agent-cursor-grad" x1="2" y1="2" x2="18" y2="20" gradientUnits="userSpaceOnUse">
      <stop stop-color="#5ce1ff"/>
      <stop offset="0.28" stop-color="#8b6cff"/>
      <stop offset="0.55" stop-color="#ff5cc8"/>
      <stop offset="0.78" stop-color="#ffd15c"/>
      <stop offset="1" stop-color="#5cff9a"/>
    </linearGradient>
  </defs>
  <path d="M4.5 2.5 L4.5 18.2 L8.4 14.6 L11.6 21.4 L14.2 20.2 L11 13.4 L16.8 13.4 Z"
    fill="url(#browser-agent-cursor-grad)" stroke="rgba(255,255,255,0.75)" stroke-width="1.15" stroke-linejoin="round"/>
</svg>`;
