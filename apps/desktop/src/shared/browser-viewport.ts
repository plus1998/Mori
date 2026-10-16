export type BrowserViewportGroup = "generic" | "mobile" | "foldable" | "tablet" | "display";
export const BROWSER_VIEWPORT_DISPLAY_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function device<const Id extends string>(
  preset: Id,
  name: string,
  group: BrowserViewportGroup,
  width: number,
  height: number,
  deviceScaleFactor: number,
  mobile = true,
  touch = true,
) {
  return { preset, name, group, width, height, deviceScaleFactor, mobile, touch } as const;
}

/**
 * Curated Chrome device-screen CSS viewports; no browser bars or engine impersonation.
 * Foldable presets use their cover-screen dimensions, without hinge/posture emulation.
 * Source: https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/emulation/EmulatedDevices.ts
 * Snapshot: 2026-10-16. Generic sizes remain available to existing Agent callers.
 */
export const BROWSER_VIEWPORT_PRESETS = [
  device("phone", "Phone", "generic", 390, 844, 3),
  device("tablet", "Tablet", "generic", 820, 1180, 2),
  device("laptop", "Laptop", "generic", 1366, 768, 1, false, false),
  device("desktop", "Desktop", "generic", 1920, 1080, 1, false, false),
  device("iphone-se", "iPhone SE", "mobile", 375, 667, 2),
  device("iphone-16", "iPhone 16", "mobile", 393, 852, 3),
  device("iphone-16-pro-max", "iPhone 16 Pro Max", "mobile", 440, 956, 3),
  device("pixel-9", "Pixel 9", "mobile", 412, 924, 2.625),
  device("pixel-9-pro", "Pixel 9 Pro", "mobile", 427, 952, 3),
  device("pixel-10", "Pixel 10", "mobile", 412, 924, 2.625),
  device("samsung-galaxy-a55", "Samsung Galaxy A55", "mobile", 360, 800, 2.25),
  device("pixel-9-pro-fold", "Pixel 9 Pro Fold", "foldable", 412, 922, 2.625),
  device("galaxy-z-fold-6", "Galaxy Z Fold 6", "foldable", 412, 968, 2.625),
  device("ipad-mini", "iPad Mini", "tablet", 768, 1024, 2),
  device("ipad-pro-13", "iPad Pro 13", "tablet", 1032, 1376, 2),
  device("surface-pro-10", "Surface Pro 10", "tablet", 960, 1440, 2),
  device("nest-hub-max", "Nest Hub Max", "display", 1280, 800, 2, false),
] as const;

export const BROWSER_VIEWPORT_PICKER_PRESETS = BROWSER_VIEWPORT_PRESETS.filter(
  (device) => device.group !== "generic",
);

export type BrowserViewportPresetId = (typeof BROWSER_VIEWPORT_PRESETS)[number]["preset"];

export interface BrowserViewport {
  preset: BrowserViewportPresetId | "custom";
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
}

export interface BrowserViewportInput {
  /** auto restores the panel-sized desktop viewport. */
  preset?: BrowserViewport["preset"] | "auto";
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  touch?: boolean;
  landscape?: boolean;
}

export interface BrowserSetViewportRequest extends BrowserViewportInput {
  browserId: string;
}

export function parseBrowserViewport(input: unknown): BrowserViewport | null {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Viewport settings must be an object.");
  const value = input as Record<string, unknown>;
  if (value.preset === "auto") {
    if (
      ["width", "height", "deviceScaleFactor", "mobile", "touch", "landscape"].some(
        (key) => value[key] !== undefined,
      )
    )
      throw new Error("preset auto cannot be combined with device settings.");
    return null;
  }
  const preset = BROWSER_VIEWPORT_PRESETS.find((item) => item.preset === value.preset);
  if (value.preset !== undefined && value.preset !== "custom" && !preset)
    throw new Error(
      "Unknown viewport preset. Call agent_browser_list_devices for supported preset IDs, or supply custom width and height.",
    );
  if ((value.width === undefined) !== (value.height === undefined))
    throw new Error("Viewport width and height must be supplied together.");
  const width = value.width !== undefined ? value.width : preset?.width;
  const height = value.height !== undefined ? value.height : preset?.height;
  for (const [label, size] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (typeof size !== "number" || !Number.isInteger(size) || size < 100 || size > 4096)
      throw new Error(`Viewport ${label} must be an integer between 100 and 4096 CSS pixels.`);
  }
  const deviceScaleFactor =
    value.deviceScaleFactor !== undefined ? value.deviceScaleFactor : (preset?.deviceScaleFactor ?? 1);
  if (
    typeof deviceScaleFactor !== "number" ||
    !Number.isFinite(deviceScaleFactor) ||
    deviceScaleFactor < 1 ||
    deviceScaleFactor > 4
  )
    throw new Error("deviceScaleFactor must be between 1 and 4.");
  for (const field of ["mobile", "touch", "landscape"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean")
      throw new Error(`${field} must be a boolean.`);
  }
  const mobile = (value.mobile ?? preset?.mobile ?? false) as boolean;
  const touch = (value.touch ?? preset?.touch ?? mobile) as boolean;
  const dimensions = { width: width as number, height: height as number };
  if (typeof value.landscape === "boolean") {
    dimensions.width = value.landscape
      ? Math.max(width as number, height as number)
      : Math.min(width as number, height as number);
    dimensions.height = value.landscape
      ? Math.min(width as number, height as number)
      : Math.max(width as number, height as number);
  }
  return {
    preset:
      preset &&
      Math.min(dimensions.width, dimensions.height) === Math.min(preset.width, preset.height) &&
      Math.max(dimensions.width, dimensions.height) === Math.max(preset.width, preset.height) &&
      mobile === preset.mobile &&
      touch === preset.touch &&
      deviceScaleFactor === preset.deviceScaleFactor
        ? preset.preset
        : "custom",
    ...dimensions,
    deviceScaleFactor,
    mobile,
    touch,
  };
}

/** Display-only scaling: CSS layout and CDP coordinates retain the device's dimensions. */
export function fitBrowserViewport(
  bounds: { width: number; height: number },
  viewport: Pick<BrowserViewport, "width" | "height">,
  displayScale?: number,
) {
  const scale =
    displayScale ??
    Math.min(
      1,
      Math.max(1, bounds.width - 24) / viewport.width,
      Math.max(1, bounds.height - 24) / viewport.height,
    );
  return {
    scale,
    width: viewport.width * scale,
    height: viewport.height * scale,
    left: Math.max(12, (bounds.width - viewport.width * scale) / 2),
    top: Math.max(12, (bounds.height - viewport.height * scale) / 2),
  };
}

/** Responsive mode follows the available panel until the user drags an edge. */
export function responsiveBrowserViewport(bounds: { width: number; height: number }) {
  return {
    width: Math.max(100, Math.min(4096, Math.floor(bounds.width - 24))),
    height: Math.max(100, Math.min(4096, Math.floor(bounds.height - 24))),
  };
}

export type BrowserViewportResizeEdge = "right" | "bottom" | "corner";

/** Centered axes move half as far as the size change; overflowing axes anchor at the start. */
export function resizeBrowserViewport(
  start: { width: number; height: number },
  delta: { x: number; y: number },
  scale: number,
  edge: BrowserViewportResizeEdge,
  centered = { x: true, y: true },
) {
  return {
    width:
      edge === "bottom"
        ? start.width
        : Math.max(100, Math.min(4096, Math.round(start.width + (delta.x * (centered.x ? 2 : 1)) / scale))),
    height:
      edge === "right"
        ? start.height
        : Math.max(100, Math.min(4096, Math.round(start.height + (delta.y * (centered.y ? 2 : 1)) / scale))),
  };
}
