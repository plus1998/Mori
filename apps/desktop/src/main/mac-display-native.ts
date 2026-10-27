import { createRequire } from "node:module";
import type { DisplayDimmingMethod } from "../shared/display-control";

function check(result: number, operation: string): void {
  if (result !== 0) throw new Error(`${operation} failed (${result}).`);
}

// Main process only. Reuses the packaged koffi dependency; no command line tools,
// accessibility permission, or persistent changes to macOS power settings.
export function createMacActivityAssertion(): { refresh(): void; release(): void } {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const io = koffi.load("/System/Library/Frameworks/IOKit.framework/IOKit");
  const services = koffi.load("/System/Library/Frameworks/CoreServices.framework/CoreServices");
  // IOPM assertions alone do not reliably reset the screen saver's idle timer.
  // UpdateSystemActivity(UsrActivity) resets it without moving the pointer or
  // injecting keys. Deprecated by Apple, but still exported on current macOS.
  // https://stackoverflow.com/questions/69186089/prevent-mac-screen-saver
  const updateActivity = services.func("int UpdateSystemActivity(uint8_t)");
  const string = cf.func("void *CFStringCreateWithCString(void *, const char *, uint32_t)");
  const free = cf.func("void CFRelease(void *)");
  const declare = io.func("int IOPMAssertionDeclareUserActivity(void *, uint32_t, _Inout_ uint32_t *)");
  const create = io.func("int IOPMAssertionCreateWithName(void *, uint32_t, void *, _Out_ uint32_t *)");
  const release = io.func("int IOPMAssertionRelease(uint32_t)");
  const name = string(null, "Mori desktop automation", 0x08000100);
  const type = string(null, "PreventUserIdleDisplaySleep", 0x08000100);
  const displayId = [0];
  const activityId = [0];
  try {
    check(create(type, 255, name, displayId), "PreventUserIdleDisplaySleep");
  } finally {
    free(type);
    free(name);
  }
  return {
    refresh() {
      const label = string(null, "Mori desktop automation", 0x08000100);
      try {
        check(declare(label, 0, activityId), "IOPMAssertionDeclareUserActivity");
        check(updateActivity(1), "UpdateSystemActivity");
      } finally {
        free(label);
      }
    },
    release() {
      if (activityId[0]) release(activityId[0]);
      if (displayId[0]) release(displayId[0]);
      activityId[0] = 0;
      displayId[0] = 0;
    },
  };
}

export interface MacDisplayInfo {
  id: number;
  key: string;
  name: string;
  internal: boolean;
}

export type MacDisplayLevels =
  | { method: "backlight"; value: number }
  | { method: "software"; red: Float32Array; green: Float32Array; blue: Float32Array };

export interface MacBrightnessApi {
  displays(): MacDisplayInfo[];
  get(id: number, method?: DisplayDimmingMethod): MacDisplayLevels;
  set(id: number, levels: MacDisplayLevels): void;
}

export function minimumDisplayLevels(levels: MacDisplayLevels): MacDisplayLevels {
  if (levels.method === "backlight") return { method: "backlight", value: 0 };
  const zero = new Float32Array(levels.red.length);
  return { method: "software", red: zero, green: zero, blue: zero };
}

export function displayLevelsAreMinimum(levels: MacDisplayLevels): boolean {
  if (levels.method === "backlight") return levels.value <= 0.001;
  return [levels.red, levels.green, levels.blue].every((channel) =>
    channel.every((value) => Math.abs(value) <= 0.001),
  );
}

export function createMacBrightnessApi(
  labelForDisplay: (id: number) => string | undefined = () => undefined,
): MacBrightnessApi {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const colors = koffi.load("/System/Library/Frameworks/ColorSync.framework/ColorSync");
  // Same native backlight API used by MonitorControl's AppleDisplay implementation.
  const ds = koffi.load("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices");
  const list = cg.func("int CGGetOnlineDisplayList(uint32_t, _Out_ uint32_t *, _Out_ uint32_t *)");
  const builtIn = cg.func("uint32_t CGDisplayIsBuiltin(uint32_t)");
  const get = ds.func("int DisplayServicesGetBrightness(uint32_t, _Out_ float *)");
  const set = ds.func("int DisplayServicesSetBrightness(uint32_t, float)");
  const uuid = colors.func("void *CGDisplayCreateUUIDFromDisplayID(uint32_t)");
  const uuidString = cf.func("void *CFUUIDCreateString(void *, void *)");
  const string = cf.func("bool CFStringGetCString(void *, _Out_ char *, long, uint32_t)");
  const release = cf.func("void CFRelease(void *)");
  const capacity = cg.func("uint32_t CGDisplayGammaTableCapacity(uint32_t)");
  const getGamma = cg.func(
    "int CGGetDisplayTransferByTable(uint32_t, uint32_t, _Out_ float *, _Out_ float *, _Out_ float *, _Out_ uint32_t *)",
  );
  const setGamma = cg.func("int CGSetDisplayTransferByTable(uint32_t, uint32_t, float *, float *, float *)");

  function displayKey(id: number): string {
    const ref = uuid(id);
    if (!ref) throw new Error(`Display ${id}: UUID unavailable.`);
    try {
      const text = uuidString(null, ref);
      if (!text) throw new Error(`Display ${id}: UUID string unavailable.`);
      try {
        const buffer = Buffer.alloc(128);
        if (!string(text, buffer, buffer.length, 0x08000100)) throw new Error("Invalid display UUID.");
        return buffer.toString("utf8", 0, buffer.indexOf(0));
      } finally {
        release(text);
      }
    } finally {
      release(ref);
    }
  }

  return {
    displays() {
      const count = [0];
      check(list(0, null, count), "CGGetOnlineDisplayList");
      const ids = new Uint32Array(count[0] ?? 0);
      if (!ids.length) return [];
      check(list(ids.length, ids, count), "CGGetOnlineDisplayList");
      return Array.from(ids.slice(0, count[0])).map((id) => ({
        id,
        key: displayKey(id),
        name: labelForDisplay(id) ?? "",
        internal: builtIn(id) !== 0,
      }));
    },
    get(id, method) {
      if (method !== "software") {
        const value = [0];
        const result = get(id, value);
        const brightness = value[0];
        if (
          result === 0 &&
          brightness !== undefined &&
          Number.isFinite(brightness) &&
          brightness >= 0 &&
          brightness <= 1
        ) {
          return { method: "backlight", value: brightness };
        }
        if (method === "backlight") throw new Error(`Display ${id}: brightness read failed (${result}).`);
      }
      // HDMI/DDC, DisplayLink and virtual displays may have no native backlight
      // API. Software dimming is an explicit mode in the UI, not a claim that
      // their backlight is controlled. Gamma tables add no windows or hit targets.
      const size = capacity(id);
      if (size < 1 || size > 65536) throw new Error(`Display ${id}: software dimming unavailable.`);
      const red = new Float32Array(size);
      const green = new Float32Array(size);
      const blue = new Float32Array(size);
      const count = [0];
      check(getGamma(id, size, red, green, blue, count), `Display ${id}: CGGetDisplayTransferByTable`);
      const samples = count[0] ?? 0;
      if (samples < 1 || samples > size) throw new Error(`Display ${id}: invalid gamma table.`);
      return {
        method: "software",
        red: red.slice(0, samples),
        green: green.slice(0, samples),
        blue: blue.slice(0, samples),
      };
    },
    set(id, levels) {
      if (levels.method === "backlight") {
        check(set(id, levels.value), `Display ${id}: DisplayServicesSetBrightness`);
      } else {
        check(
          setGamma(id, levels.red.length, levels.red, levels.green, levels.blue),
          `Display ${id}: CGSetDisplayTransferByTable`,
        );
      }
    },
  };
}
