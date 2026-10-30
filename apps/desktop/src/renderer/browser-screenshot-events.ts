export const BROWSER_SCREENSHOT_CAPTURED_EVENT = "eco:browser-screenshot-captured";

export interface BrowserScreenshotCaptured {
  artifactId: string;
  scopeId: string;
}

export function showBrowserScreenshot(detail: BrowserScreenshotCaptured): void {
  window.dispatchEvent(new CustomEvent(BROWSER_SCREENSHOT_CAPTURED_EVENT, { detail }));
}
