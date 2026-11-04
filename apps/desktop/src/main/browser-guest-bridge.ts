import type { BrowserWindow, WebContents, WebPreferences } from "electron";
import { BROWSER_WEBVIEW_TAB_ID_ATTR } from "../shared/browser";
import type { BrowserHost } from "./browser-host";

/**
 * Wire Electron `<webview>` guest attach to BrowserHost.
 * Renderer owns the DOM webview; main process receives guest WebContents for CDP.
 */
export function installBrowserGuestBridge(mainWindow: BrowserWindow, host: BrowserHost, windowBrowserId?: string): () => void {
  const onWillAttach = (
    _event: Electron.Event,
    webPreferences: WebPreferences,
    params: Record<string, string>,
  ) => {
    delete webPreferences.preload;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.javascript = true;
    const partition = params.partition?.trim();
    if (partition) {
      webPreferences.partition = partition;
    }
    // Electron only forwards supported webview attributes; our custom DOM id is
    // not always present in params. Account partitions carry the logical tab id.
    const markedPartition = partition?.startsWith("account:") || partition?.startsWith("browser:");
    const browserId = windowBrowserId || params[BROWSER_WEBVIEW_TAB_ID_ATTR]?.trim()
      || (markedPartition && partition ? partition.slice(partition.indexOf(":") + 1) : undefined);
    if (browserId) {
      const guestSession = host.getAccountGuestSession(browserId) ?? host.getGuestSession?.(browserId);
      if (markedPartition && !guestSession) {
        _event.preventDefault();
        return;
      }
      if (guestSession) {
        webPreferences.session = guestSession;
        delete webPreferences.partition;
      }
      // restore() requires a pristine WebContents. Suppress the webview's initial
      // blank load and let the renderer register the guest at did-attach.
      if (host.hasNavigationToRestore?.(browserId)) params.src = "";
      host.notePendingGuestAttach(browserId);
    }
  };

  const onDidAttach = (_event: Electron.Event, guestWebContents: WebContents) => {
    // The renderer knows the exact browser id at did-attach, even when several
    // guests share a Session. Never guess a standalone page from the main queue.
    if (windowBrowserId) return;
    const browserId = host.consumePendingGuestAttach(guestWebContents.id, guestWebContents.session);
    if (browserId) {
      host.registerGuestWebContents(browserId, guestWebContents);
    }
  };

  const wc = mainWindow.webContents;
  wc.on("will-attach-webview", onWillAttach);
  wc.on("did-attach-webview", onDidAttach);

  return () => {
    if (wc.isDestroyed()) {
      return;
    }
    wc.removeListener("will-attach-webview", onWillAttach);
    wc.removeListener("did-attach-webview", onDidAttach);
  };
}
