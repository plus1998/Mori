import type { WebContents } from "electron";

/** Runs in the embedder, and only changes the DOM belonging to this exact guest. */
function updateCaptureSurface(guestId: number, prepare: boolean): boolean {
  const marker = String(guestId);
  const styleId = `mori-browser-capture-${marker}`;
  const attributes = ["data-browser-capture-viewport", "data-browser-capture-host", "data-browser-capture-guest"];
  if (!prepare) {
    document.getElementById(styleId)?.remove();
    for (const attribute of attributes) {
      for (const node of document.querySelectorAll(`[${attribute}="${marker}"]`)) node.removeAttribute(attribute);
    }
    return false;
  }
  const guest = [...document.querySelectorAll<HTMLElement & { getWebContentsId(): number }>("webview")].find(node => {
    try {
      return node.getWebContentsId() === guestId;
    } catch {
      return false;
    }
  });
  if (!guest) throw new Error("Screenshot guest is no longer attached to its browser window.");
  const bounds = guest.getBoundingClientRect();
  const computed = getComputedStyle(guest);
  if (computed.visibility === "visible" && computed.opacity !== "0" &&
      bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
      bounds.left < innerWidth && bounds.top < innerHeight) return false;

  const host = guest.closest<HTMLElement>("[data-browser-host]");
  const viewport = host?.closest<HTMLElement>(".browser-viewport-scroll");
  if (!host || !viewport) throw new Error("Screenshot guest has no persistent browser host.");
  // Keep the same guest and CSS dimensions. Opacity allows capturePage to request
  // a compositor frame; visibility:hidden and a completely off-window rect do not.
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    [data-browser-capture-viewport="${marker}"] {
      left:0!important;top:0!important;visibility:visible!important;
      opacity:0!important;pointer-events:none!important;
    }
    [data-browser-capture-host="${marker}"] {
      visibility:visible!important;pointer-events:none!important;
    }
    [data-browser-capture-viewport="${marker}"] [data-browser-capture-host="${marker}"] {
      left:0!important;top:0!important;transform:none!important;
    }
    [data-browser-capture-guest="${marker}"] {
      visibility:visible!important;opacity:0!important;pointer-events:none!important;
    }
  `;
  document.head.append(style);
  if (host.dataset.browserHostHidden === "true") viewport.setAttribute(attributes[0]!, marker);
  host.setAttribute(attributes[1]!, marker);
  guest.setAttribute(attributes[2]!, marker);
  // Flush the new guest bounds before main requests a compositor frame.
  guest.getBoundingClientRect();
  return true;
}

export async function prepareGuestScreenshotSurface(guest: WebContents): Promise<{
  prepared: boolean;
  dispose(): Promise<void>;
}> {
  const embedder = guest.hostWebContents;
  if (!embedder) return { prepared: false, dispose: async () => {} };
  const script = (prepare: boolean) => `(${updateCaptureSurface.toString()})(${guest.id}, ${prepare})`;
  const throttling = guest.backgroundThrottling;
  const embedderThrottling = embedder.backgroundThrottling;
  let prepared = false;
  let subscribed = false;
  const dispose = async () => {
    try {
      if (!embedder.isDestroyed()) await embedder.executeJavaScript(script(false));
    } finally {
      if (prepared) {
        if (!guest.isDestroyed()) {
          if (subscribed) guest.endFrameSubscription();
          guest.setBackgroundThrottling(throttling);
        }
        if (!embedder.isDestroyed()) embedder.setBackgroundThrottling(embedderThrottling);
      }
    }
  };
  try {
    prepared = await embedder.executeJavaScript(script(true)) as boolean;
    if (prepared) {
      guest.setBackgroundThrottling(false);
      embedder.setBackgroundThrottling(false);
      // Keep Viz producing guest frames even if the entire containing window is
      // hidden. No window is shown or focused; dispose stops the video capturer.
      guest.beginFrameSubscription(() => {});
      subscribed = true;
      await embedder.executeJavaScript(`new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Screenshot host did not produce a compositor frame.")), 2000);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
      })`);
    }
    return { prepared, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
