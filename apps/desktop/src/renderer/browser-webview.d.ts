import type { BROWSER_WEBVIEW_TAB_ID_ATTR } from "../shared/browser";

/** Electron `<webview>` guest element (renderer DOM). */
export interface EcoBrowserWebviewElement extends HTMLElement {
  src: string;
  partition: string;
  allowpopups?: boolean;
  isLoading?: () => boolean;
  getWebContentsId?: () => number;
  loadURL?: (url: string) => void;
  reload?: () => void;
  goBack?: () => void;
  goForward?: () => void;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  addEventListener(
    type: "did-attach" | "dom-ready" | "did-start-loading" | "did-stop-loading" | "did-fail-load" | "destroyed",
    listener: () => void,
  ): void;
  removeEventListener(
    type: "did-attach" | "dom-ready" | "did-start-loading" | "did-stop-loading" | "did-fail-load" | "destroyed",
    listener: () => void,
  ): void;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: EcoBrowserWebviewElement;
  }
}

export { BROWSER_WEBVIEW_TAB_ID_ATTR };
