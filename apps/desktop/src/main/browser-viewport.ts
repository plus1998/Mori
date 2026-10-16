import type { WebContents } from "electron";
import type { BrowserViewport } from "../shared/browser-viewport";
import { assertBrowserGuestWebContents } from "./browser-cdp-proxy";

/** Use Chromium emulation, so layout, media queries, screenshots and input share CSS coordinates. */
export async function applyBrowserViewport(
  guest: WebContents,
  viewport: BrowserViewport | null,
): Promise<void> {
  assertBrowserGuestWebContents(guest);
  if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  await guest.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
    enabled: viewport?.touch ?? false,
    maxTouchPoints: viewport?.touch ? 5 : 1,
  });
  if (!viewport) {
    await guest.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    return;
  }
  await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
    screenOrientation: {
      type: viewport.width > viewport.height ? "landscapePrimary" : "portraitPrimary",
      angle: viewport.width > viewport.height ? 90 : 0,
    },
  });
}
