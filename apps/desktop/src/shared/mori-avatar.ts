import { MORI_PET_ANIMATIONS, MORI_PET_CELL_HEIGHT, MORI_PET_CELL_WIDTH, type MoriPetAnimation } from "./mori-pet";

export interface MoriAvatarSettings {
  petKey: string;
  animation: MoriPetAnimation;
  frame: number;
  zoom: number;
}

/** Measure only the chosen cell: other poses must not shrink a portrait. */
export function moriAvatarCrop(pixels: Uint8ClampedArray, atlasWidth: number, avatar: MoriAvatarSettings) {
  const originX = avatar.frame * MORI_PET_CELL_WIDTH;
  const originY = MORI_PET_ANIMATIONS[avatar.animation].row * MORI_PET_CELL_HEIGHT;
  let left = MORI_PET_CELL_WIDTH, top = MORI_PET_CELL_HEIGHT, right = -1, bottom = -1;
  for (let y = 0; y < MORI_PET_CELL_HEIGHT; y++) {
    for (let x = 0; x < MORI_PET_CELL_WIDTH; x++) {
      if ((pixels[((originY + y) * atlasWidth + originX + x) * 4 + 3] ?? 0) < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error("所选头像帧为空，请选择其他帧。");
  const side = Math.max(right - left + 1, bottom - top + 1) * 1.12 / avatar.zoom;
  // Keep the head at the top when zooming in; include a little room for hair/accessories.
  const x = (left + right + 1 - side) / 2;
  const y = top - side * 0.06;
  return { x: originX + x, y: originY + y, size: side, originX, originY };
}
