import type { BrowserSelection } from "../shared/browser-selection";

export const BROWSER_SELECTION_INSERT_EVENT = "eco:browser-selection-insert";
export const BROWSER_SELECTION_PREVIEW_EVENT = "eco:browser-selection-preview";
export const BROWSER_SELECTION_REVEAL_EVENT = "eco:browser-selection-reveal";

export function insertBrowserSelection(selection: BrowserSelection) {
  window.dispatchEvent(new CustomEvent(BROWSER_SELECTION_INSERT_EVENT, { detail: selection }));
}

export function previewBrowserSelection(id: string) {
  window.dispatchEvent(new CustomEvent(BROWSER_SELECTION_PREVIEW_EVENT, { detail: id }));
}
