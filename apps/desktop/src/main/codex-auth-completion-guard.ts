import type { AccountBrowserPage } from "./account-browser-page";
import { isCodexAuthCompletionPageText } from "./codex-browser-login";

/** Remote success can precede the app-server callback. Keep the tab until it arrives. */
export function installCodexAuthCompletionGuard(page: AccountBrowserPage, cancelLogin: () => void): {
  allowClose: () => void;
  dispose: () => void;
} {
  const wc = page.webContents;
  let stopped = false;
  let checking = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    wc.removeListener("dom-ready", check);
    wc.removeListener("did-finish-load", check);
    wc.removeListener("did-navigate", check);
    wc.removeListener("did-navigate-in-page", check);
  };
  const check = () => {
    if (stopped || checking || page.isDestroyed() || wc.isDestroyed()) return;
    checking = true;
    void wc.executeJavaScript("document.body?.innerText ?? ''", true).then(text => {
      if (stopped || page.isDestroyed() || typeof text !== "string" || !isCodexAuthCompletionPageText(text)) return;
      page.setClosable(false);
      stop();
    }).catch(() => {
      // OAuth may replace the document during this read. Retry on the next load.
    }).finally(() => { checking = false; });
  };
  const timer = setInterval(check, 1_000);
  wc.on("dom-ready", check);
  wc.on("did-finish-load", check);
  wc.on("did-navigate", check);
  wc.on("did-navigate-in-page", check);
  const offClosed = page.onClosed(() => { stop(); cancelLogin(); });
  check();
  return {
    allowClose: () => { stop(); page.setClosable(true); },
    dispose: () => { stop(); offClosed(); },
  };
}
