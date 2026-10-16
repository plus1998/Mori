import { expect, test } from "bun:test";
import type { WebContents } from "electron";
import { agentBrowserCoreToolsCatalog } from "../src/main/agent-browser-core-tools";
import { applyBrowserViewport } from "../src/main/browser-viewport";
import {
  getBrowserWebviewDisplayScale,
  setBrowserWebviewDisplayScale,
  subscribeBrowserWebviewViewportRect,
} from "../src/renderer/browser-webview-layout";
import {
  BROWSER_VIEWPORT_PICKER_PRESETS,
  BROWSER_VIEWPORT_PRESETS,
  fitBrowserViewport,
  parseBrowserViewport,
  resizeBrowserViewport,
  responsiveBrowserViewport,
} from "../src/shared/browser-viewport";

test("device picker stays curated and matches Chrome device-screen metrics", () => {
  expect(BROWSER_VIEWPORT_PICKER_PRESETS.map((device) => device.preset)).toEqual([
    "iphone-se",
    "iphone-16",
    "iphone-16-pro-max",
    "pixel-9",
    "pixel-9-pro",
    "pixel-10",
    "samsung-galaxy-a55",
    "pixel-9-pro-fold",
    "galaxy-z-fold-6",
    "ipad-mini",
    "ipad-pro-13",
    "surface-pro-10",
    "nest-hub-max",
  ]);
  expect(parseBrowserViewport({ preset: "iphone-se" })).toMatchObject({
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
  });
  expect(parseBrowserViewport({ preset: "iphone-16" })).toMatchObject({
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
  });
  expect(parseBrowserViewport({ preset: "iphone-16-pro-max", landscape: true })).toMatchObject({
    preset: "iphone-16-pro-max",
    width: 956,
    height: 440,
  });
  expect(parseBrowserViewport({ preset: "pixel-9" })).toMatchObject({
    width: 412,
    height: 924,
    deviceScaleFactor: 2.625,
  });
});

test("responsive drag uses CSS coordinates at the display scale and clamps both axes", () => {
  expect(responsiveBrowserViewport({ width: 564, height: 700 })).toEqual({ width: 540, height: 676 });
  expect(resizeBrowserViewport({ width: 1000, height: 800 }, { x: -30, y: 20 }, 0.5, "corner")).toEqual({
    width: 880,
    height: 880,
  });
  expect(resizeBrowserViewport({ width: 1000, height: 800 }, { x: 25, y: 100 }, 0.5, "right")).toEqual({
    width: 1100,
    height: 800,
  });
  expect(resizeBrowserViewport({ width: 1000, height: 800 }, { x: 25, y: -30 }, 0.5, "bottom")).toEqual({
    width: 1000,
    height: 680,
  });
  expect(resizeBrowserViewport({ width: 1000, height: 800 }, { x: -5000, y: 5000 }, 1, "corner")).toEqual({
    width: 100,
    height: 4096,
  });
});

test("every UI device preset is accepted by the parser and advertised to Agents", () => {
  const tool = agentBrowserCoreToolsCatalog().find((item) => item.name === "agent_browser_set_viewport");
  const schema = tool?.inputSchema as { properties: { preset: { enum: string[] } } };
  expect(new Set(BROWSER_VIEWPORT_PRESETS.map((item) => item.preset)).size).toBe(
    BROWSER_VIEWPORT_PRESETS.length,
  );
  for (const device of BROWSER_VIEWPORT_PRESETS) {
    expect(parseBrowserViewport({ preset: device.preset })).toMatchObject({
      preset: device.preset,
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
    });
    expect(schema.properties.preset.enum).toContain(device.preset);
  }
  expect(agentBrowserCoreToolsCatalog().some((tool) => tool.name === "agent_browser_list_devices")).toBe(
    true,
  );
});

test("unchanged dimensions retain the selected model; modified settings become custom", () => {
  const device = parseBrowserViewport({ preset: "iphone-16" });
  expect(parseBrowserViewport(device)?.preset).toBe("iphone-16");
  expect(parseBrowserViewport({ ...device, width: 852, height: 393 })?.preset).toBe("iphone-16");
  expect(parseBrowserViewport({ ...device, width: 400 })?.preset).toBe("custom");
  expect(parseBrowserViewport({ ...device, touch: false })?.preset).toBe("custom");
});

test("device presets separate CSS dimensions, DPR, mobile layout and orientation", () => {
  expect(parseBrowserViewport({ preset: "phone" })).toEqual({
    preset: "phone",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  });
  expect(parseBrowserViewport({ preset: "tablet", landscape: true })).toEqual({
    preset: "tablet",
    width: 1180,
    height: 820,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
  });
  expect(parseBrowserViewport({ width: 1280, height: 720 })).toEqual({
    preset: "custom",
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
  });
  expect(parseBrowserViewport({ preset: "auto" })).toBeNull();
});

test("invalid device settings fail explicitly without coercion", () => {
  for (const input of [
    {},
    { preset: "missing" },
    { preset: "phone", width: null, height: null },
    { preset: "phone", deviceScaleFactor: null },
    { width: 390 },
    { width: "390", height: 844 },
    { width: 390.5, height: 844 },
    { width: 5000, height: 844 },
    { width: 390, height: 844, deviceScaleFactor: NaN },
    { preset: "phone", touch: "true" },
    { preset: "auto", width: 390 },
  ]) {
    expect(() => parseBrowserViewport(input)).toThrow();
  }
});

test("fit scales the display within panel bounds without changing actual device size", () => {
  const device = { width: 1920, height: 1080 };
  const fit = fitBrowserViewport({ width: 600, height: 700 }, device);
  expect(fit.scale).toBe(0.3);
  expect(fit.width).toBe(576);
  expect(fit.height).toBe(324);
  expect(fit.left).toBe(12);
  expect(fit.top).toBe(188);
  expect(device).toEqual({ width: 1920, height: 1080 });
  expect(fitBrowserViewport({ width: 1000, height: 1200 }, { width: 390, height: 844 }).scale).toBe(1);
});

test("device emulation never attaches to the Eco main window", async () => {
  const guest = { isDestroyed: () => false, getType: () => "window" } as unknown as WebContents;
  await expect(applyBrowserViewport(guest, parseBrowserViewport({ preset: "phone" }))).rejects.toThrow(
    "non-guest",
  );
});

test("manual display zoom preserves CSS dimensions and leaves oversized previews scrollable", () => {
  const viewport = { width: 412, height: 924 };
  const bounds = { width: 564, height: 732 };
  for (const scale of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    const layout = fitBrowserViewport(bounds, viewport, scale);
    expect(layout.scale).toBe(scale);
    expect(layout.width).toBe(412 * scale);
    expect(layout.height).toBe(924 * scale);
    expect(layout.left).toBeGreaterThanOrEqual(12);
    expect(layout.top).toBeGreaterThanOrEqual(12);
  }
  expect(fitBrowserViewport(bounds, viewport).height).toBe(708);
  expect(viewport).toEqual({ width: 412, height: 924 });
  expect(resizeBrowserViewport(viewport, { x: 20, y: 30 }, 2, "corner", { x: false, y: false })).toEqual({
    width: 422,
    height: 939,
  });
});

test("display zoom stays per tab, publishes changes, and rejects invalid scales", () => {
  let updates = 0;
  const unsubscribe = subscribeBrowserWebviewViewportRect("zoom-tab-a", () => {
    updates++;
  });
  setBrowserWebviewDisplayScale("zoom-tab-a", 2);
  setBrowserWebviewDisplayScale("zoom-tab-a", 2);
  expect(updates).toBe(1);
  expect(getBrowserWebviewDisplayScale("zoom-tab-a")).toBe(2);
  expect(getBrowserWebviewDisplayScale("zoom-tab-b")).toBeUndefined();
  expect(() => setBrowserWebviewDisplayScale("zoom-tab-a", Number.NaN)).toThrow();
  setBrowserWebviewDisplayScale("zoom-tab-a", undefined);
  expect(updates).toBe(2);
  expect(getBrowserWebviewDisplayScale("zoom-tab-a")).toBeUndefined();
  unsubscribe();
});

test("clearing device emulation resets touch and metrics; failures propagate", async () => {
  const calls: string[] = [];
  const guest = {
    isDestroyed: () => false,
    getType: () => "webview",
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        calls.push(method);
        if (method.includes("Touch")) expect(params?.enabled).toBe(false);
      },
    },
  } as unknown as WebContents;
  await applyBrowserViewport(guest, null);
  expect(calls).toEqual(["Emulation.setTouchEmulationEnabled", "Emulation.clearDeviceMetricsOverride"]);
  guest.debugger.sendCommand = async () => {
    throw new Error("Target closed");
  };
  await expect(applyBrowserViewport(guest, null)).rejects.toThrow("Target closed");
});
