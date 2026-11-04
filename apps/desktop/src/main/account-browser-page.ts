import type { BrowserWindow, WebContents } from "electron";

/** A logical built-in browser tab; its guest can be recreated by the renderer. */
export interface AccountBrowserPage {
  readonly id: string;
  readonly webContents: WebContents;
  readonly window?: BrowserWindow | undefined;
  isDestroyed(): boolean;
  focus(): void;
  close(): Promise<void>;
  onClosed(listener: () => void): () => void;
  setClosable(closable: boolean): void;
}
