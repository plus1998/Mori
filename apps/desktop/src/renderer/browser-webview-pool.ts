import { BROWSER_WEBVIEW_TAB_ID_ATTR } from "../shared/browser";
import type { EcoBrowserWebviewElement } from "./browser-webview";
import { resolveBrowserWebviewHostSlot, subscribeBrowserWebviewHostSlot } from "./browser-webview-layout";

export type BrowserWebviewPoolDesiredInstance = {
  id: string;
  partition: string;
};

type BrowserWebviewPoolEntry = {
  browserId: string;
  partition: string;
  webview: EcoBrowserWebviewElement;
  overlay: HTMLDivElement;
  registeredGuestId: number | undefined;
  intentionalRelease: boolean;
  hostSlotUnsubscribe: (() => void) | undefined;
  attachTimer: ReturnType<typeof setTimeout> | undefined;
  onAttach: () => void;
  onDomReady: () => void;
  onDestroyed: () => void;
};

function removeStrayWebviews(browserId: string, keep?: EcoBrowserWebviewElement): void {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return;
  }
  for (const node of document.querySelectorAll(`webview[${BROWSER_WEBVIEW_TAB_ID_ATTR}="${browserId}"]`)) {
    if (keep && (node as unknown as EcoBrowserWebviewElement) === keep) {
      continue;
    }
    node.remove();
  }
}

function createGuestElements(
  browserId: string,
  partition: string,
): { webview: EcoBrowserWebviewElement; overlay: HTMLDivElement } {
  const webview = document.createElement("webview") as EcoBrowserWebviewElement;
  webview.className = "browser-panel-webview";
  webview.src = "about:blank";
  webview.partition = partition;
  webview.allowpopups = true;
  webview.setAttribute(BROWSER_WEBVIEW_TAB_ID_ATTR, browserId);

  const overlay = document.createElement("div");
  overlay.className = "browser-panel-overlay-host";
  overlay.setAttribute("aria-hidden", "true");

  return { webview, overlay };
}

/**
 * Imperative owner of renderer `<webview>` guests.
 * React never creates or destroys guests — only this pool does, driven by
 * main-process {@link BrowserViewState.allGuestInstances}.
 */
export class BrowserWebviewPool {
  private readonly entries = new Map<string, BrowserWebviewPoolEntry>();

  /** Reconcile DOM guests with main-process truth (create / release only). */
  sync(desired: readonly BrowserWebviewPoolDesiredInstance[]): void {
    if (typeof document === "undefined") {
      return;
    }
    const desiredById = new Map(desired.map((instance) => [instance.id, instance.partition]));
    for (const browserId of [...this.entries.keys()]) {
      if (!desiredById.has(browserId)) {
        this.release(browserId);
      }
    }
    for (const instance of desired) {
      this.ensure(instance.id, instance.partition);
    }
  }

  /** Create guest once; idempotent when already alive. */
  ensure(browserId: string, partition: string): EcoBrowserWebviewElement | null {
    if (typeof document === "undefined") {
      return null;
    }
    const id = browserId.trim();
    const part = partition.trim();
    if (!id || !part) {
      return null;
    }

    const existing = this.entries.get(id);
    if (existing) {
      if (existing.partition !== part) {
        this.release(id);
        return this.ensure(id, part);
      }
      if (existing.webview.isConnected) {
        this.attach(id);
        return existing.webview;
      }
      this.disposeEntry(existing);
      this.entries.delete(id);
    }

    const { webview, overlay } = createGuestElements(id, part);
    removeStrayWebviews(id);
    const entry: BrowserWebviewPoolEntry = {
      browserId: id,
      partition: part,
      webview,
      overlay,
      registeredGuestId: undefined,
      intentionalRelease: false,
      hostSlotUnsubscribe: undefined,
      attachTimer: undefined,
      onAttach: () => {},
      onDomReady: () => {},
      onDestroyed: () => {},
    };

    this.wireGuest(entry);
    entry.hostSlotUnsubscribe = subscribeBrowserWebviewHostSlot(id, () => {
      this.attach(id);
    });
    this.entries.set(id, entry);
    this.attach(id);
    return webview;
  }

  /** Move guest into its persistent host slot without recreating WebContents. */
  attach(browserId: string): void {
    const entry = this.entries.get(browserId.trim());
    const slot = resolveBrowserWebviewHostSlot(browserId);
    if (!entry || !slot) {
      return;
    }
    if (entry.webview.parentElement === slot && entry.overlay.parentElement === slot) {
      return;
    }
    slot.append(entry.webview, entry.overlay);
  }

  /** Destroy guest — only when main process removed the browser id. */
  release(browserId: string): void {
    const id = browserId.trim();
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    entry.intentionalRelease = true;
    this.disposeEntry(entry);
    this.entries.delete(id);
  }

  has(browserId: string): boolean {
    return this.entries.has(browserId.trim());
  }

  /** @internal tests */
  getWebviewForTests(browserId: string): EcoBrowserWebviewElement | undefined {
    return this.entries.get(browserId.trim())?.webview;
  }

  resetForTests(): void {
    for (const browserId of [...this.entries.keys()]) {
      this.release(browserId);
    }
  }

  private wireGuest(entry: BrowserWebviewPoolEntry): void {
    const registerIfReady = () => {
      let guestId: number;
      try {
        guestId = entry.webview.getWebContentsId?.() ?? 0;
      } catch {
        return;
      }
      if (!guestId || guestId === entry.registeredGuestId) {
        return;
      }
      entry.registeredGuestId = guestId;
      void window.eco?.browserRegisterGuest?.({
        browserId: entry.browserId,
        webContentsId: guestId,
      });
    };

    entry.onDomReady = () => {
      registerIfReady();
    };
    entry.onAttach = () => {
      if (!entry.partition.startsWith("browser:")) return;
      const deadline = Date.now() + 1_000;
      const register = () => {
        entry.attachTimer = undefined;
        if (entry.intentionalRelease) return;
        registerIfReady();
        // did-attach can arrive before Electron's createGuest promise publishes
        // getWebContentsId(). Wait for that promise without loading a blank page.
        if (!entry.registeredGuestId && Date.now() < deadline) entry.attachTimer = setTimeout(register, 10);
      };
      if (entry.attachTimer) clearTimeout(entry.attachTimer);
      entry.attachTimer = setTimeout(register, 0);
    };
    entry.onDestroyed = () => {
      if (entry.intentionalRelease) {
        return;
      }
      entry.registeredGuestId = undefined;
      this.disposeEntry(entry);
      this.entries.delete(entry.browserId);
    };

    // Restoring history must happen before the first document loads. The attach
    // bridge suppresses about:blank for these guests; dom-ready alone would deadlock.
    entry.webview.addEventListener("did-attach", entry.onAttach);
    entry.webview.addEventListener("dom-ready", entry.onDomReady);
    entry.webview.addEventListener("destroyed", entry.onDestroyed);
  }

  private disposeEntry(entry: BrowserWebviewPoolEntry): void {
    if (entry.attachTimer) clearTimeout(entry.attachTimer);
    entry.attachTimer = undefined;
    entry.hostSlotUnsubscribe?.();
    entry.hostSlotUnsubscribe = undefined;
    entry.webview.removeEventListener("did-attach", entry.onAttach);
    entry.webview.removeEventListener("dom-ready", entry.onDomReady);
    entry.webview.removeEventListener("destroyed", entry.onDestroyed);
    try {
      entry.webview.remove();
    } catch {
      // Guest may already be destroyed by main-process wc.close().
    }
    try {
      entry.overlay.remove();
    } catch {
      // ignore
    }
  }
}

export const browserWebviewPool = new BrowserWebviewPool();
