/** Codex Pets sprite atlas: 192×208 cells, eight columns. */
export const MORI_PET_CELL_WIDTH = 192;
export const MORI_PET_CELL_HEIGHT = 208;
export const MORI_PET_COLUMNS = 8;
export const MORI_PET_ANIMATIONS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
} as const;

export type MoriPetAnimation = keyof typeof MORI_PET_ANIMATIONS;
export interface MoriPetInfo {
  key: string;
  name: string;
  description: string;
  version: 1 | 2;
}
export interface MoriPetList {
  pets: MoriPetInfo[];
  errors: string[];
}
export interface MoriPetAsset extends MoriPetInfo {
  image: string;
}

export function resizeMoriPetBounds(
  bounds: { x: number; y: number; width: number; height: number },
  size: number,
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const centeredX = bounds.x + (bounds.width - size) / 2;
  const centeredY = bounds.y + (bounds.height - size) / 2;
  return {
    x: Math.round(Math.max(area.x, Math.min(centeredX, area.x + area.width - size))),
    y: Math.round(Math.max(area.y, Math.min(centeredY, area.y + area.height - size))),
    width: size,
    height: size,
  };
}

export function moriPetFrameDuration(petKey: string, animation: MoriPetAnimation, frame: number): number {
  if (petKey === "builtin:mori" && animation === "idle" && frame === 0) return 6500;
  return MORI_PET_ANIMATIONS[animation].durations[frame] ?? MORI_PET_ANIMATIONS[animation].durations[0];
}

/** v2 cells run clockwise, with zero pointing up in screen coordinates. */
export function moriPetLookDirection(dx: number, dy: number): number {
  return ((Math.round((Math.atan2(dx, -dy) * 180) / Math.PI / 22.5) % 16) + 16) % 16;
}

/** Detect missing atlas frames instead of silently showing a blank pet. */
export function missingMoriPetFrame(
  pixels: Uint8ClampedArray,
  width: number,
  version: 1 | 2,
): string | undefined {
  const animations: Array<{ name: string; row: number; count: number }> = Object.entries(
    MORI_PET_ANIMATIONS,
  ).map(([name, animation]) => ({ name, row: animation.row, count: animation.durations.length }));
  if (version === 2)
    animations.push({ name: "视线方向", row: 9, count: 8 }, { name: "视线方向", row: 10, count: 8 });
  for (const animation of animations) {
    for (let column = 0; column < animation.count; column++) {
      let visible = false;
      const x = column * MORI_PET_CELL_WIDTH;
      const y = animation.row * MORI_PET_CELL_HEIGHT;
      for (let line = 0; line < MORI_PET_CELL_HEIGHT && !visible; line++) {
        const start = ((y + line) * width + x) * 4 + 3;
        for (let pixel = 0; pixel < MORI_PET_CELL_WIDTH; pixel++) {
          if (pixels[start + pixel * 4]) {
            visible = true;
            break;
          }
        }
      }
      if (!visible) return `宠物精灵图缺少 ${animation.name} 的第 ${column + 1} 帧。`;
    }
  }
  return undefined;
}
