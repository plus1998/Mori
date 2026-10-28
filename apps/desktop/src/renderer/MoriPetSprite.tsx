import { useEffect, useRef, useState } from "react";
import {
  MORI_PET_ANIMATIONS,
  MORI_PET_CELL_HEIGHT,
  MORI_PET_CELL_WIDTH,
  type MoriPetAnimation,
  type MoriPetAsset,
  missingMoriPetFrame,
  moriPetFrameDuration,
} from "../shared/mori-pet";

export function MoriPetSprite({
  pet,
  animation,
  direction,
  size = 56,
  onError,
}: {
  pet: MoriPetAsset;
  animation: MoriPetAnimation;
  direction?: number | null;
  size?: number;
  onError?: (message: string) => void;
}) {
  const [frame, setFrame] = useState(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const definition = MORI_PET_ANIMATIONS[animation];
  const look = pet.version === 2 && animation === "idle" && direction != null ? direction : null;
  useEffect(() => {
    setFrame(0);
    if (look !== null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;
    let current = 0;
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      current = (current + 1) % definition.durations.length;
      setFrame(current);
      timer = setTimeout(advance, moriPetFrameDuration(pet.key, animation, current));
    };
    timer = setTimeout(advance, moriPetFrameDuration(pet.key, animation, 0));
    return () => clearTimeout(timer);
  }, [animation, definition, look, pet.key]);
  useEffect(() => {
    const image = new Image();
    image.onerror = () => errorHandler.current?.("宠物精灵图无法解码。");
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        errorHandler.current?.("无法检查宠物精灵图。");
        return;
      }
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const missing = missingMoriPetFrame(pixels, canvas.width, pet.version);
      if (missing) errorHandler.current?.(missing);
    };
    image.src = pet.image;
    return () => {
      image.onerror = null;
      image.onload = null;
    };
  }, [pet.image, pet.version]);
  const width = size;
  const height = (size * MORI_PET_CELL_HEIGHT) / MORI_PET_CELL_WIDTH;
  const row = look === null ? definition.row : 9 + Math.floor(look / 8);
  const column = look === null ? frame % definition.durations.length : look % 8;
  return (
    <span
      className="mori-pet-sprite"
      aria-hidden="true"
      style={{
        width,
        height,
        backgroundImage: `url("${pet.image}")`,
        backgroundSize: `${width * 8}px ${height * (pet.version === 2 ? 11 : 9)}px`,
        backgroundPosition: `${-column * width}px ${-row * height}px`,
      }}
    />
  );
}
