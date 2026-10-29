import type { DisplayDimmingMethod } from "../shared/display-control";

export interface ActivityAssertion {
  refresh(): void;
  release(): void;
}

export interface DisplayInfo {
  id: number;
  key: string;
  name: string;
  internal: boolean;
}

export type DisplayLevels =
  | { method: "backlight"; value: number }
  | { method: "software"; red: Float32Array; green: Float32Array; blue: Float32Array };

type Awaitable<T> = T | Promise<T>;
export interface BrightnessApi {
  displays(): Awaitable<DisplayInfo[]>;
  get(id: number, method?: DisplayDimmingMethod): Awaitable<DisplayLevels>;
  set(id: number, levels: DisplayLevels): Awaitable<void>;
  dispose?(): void;
}

export function minimumDisplayLevels(levels: DisplayLevels): DisplayLevels {
  if (levels.method === "backlight") return { method: "backlight", value: 0 };
  const zero = new Float32Array(levels.red.length);
  return { method: "software", red: zero, green: zero, blue: zero };
}

export function displayLevelsAreMinimum(levels: DisplayLevels): boolean {
  if (levels.method === "backlight") return levels.value <= 0.001;
  return [levels.red, levels.green, levels.blue].every((channel) =>
    channel.every((value) => Math.abs(value) <= 0.001),
  );
}
