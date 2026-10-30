import { useEffect, useRef, useState } from "react";
import {
  MORI_PET_ANIMATIONS,
  MORI_PET_CELL_HEIGHT,
  MORI_PET_CELL_WIDTH,
  type MoriPetAnimation,
  type MoriPetAsset,
  type MoriPetHitMap,
  missingMoriPetFrame,
  moriPetFrameDuration,
  moriPetIndicatorAnchor,
  moriPetVisibleBounds,
} from "../shared/mori-pet";

const BUBBLE_PATH =
  "M12 2.5c5.5 0 9 3.2 9 7.8s-3.5 7.8-9 7.8H8l-5 3 .9-6.1A7.3 7.3 0 0 1 3 10.3c0-4.6 3.5-7.8 9-7.8Z";

export function MoriPetSprite({
  pet,
  animation,
  direction,
  size = 56,
  onError,
  indicator,
  onHitMap,
}: {
  pet: MoriPetAsset;
  animation: MoriPetAnimation;
  direction?: number | null;
  size?: number;
  onError?: (message: string) => void;
  indicator?: "waiting" | "error" | undefined;
  onHitMap?: (map: MoriPetHitMap, bodyMap: MoriPetHitMap) => void;
}) {
  const [frame, setFrame] = useState(0);
  const [atlas, setAtlas] = useState<{
    source: string;
    image: HTMLImageElement;
    crop: NonNullable<ReturnType<typeof moriPetVisibleBounds>>;
    anchor: NonNullable<ReturnType<typeof moriPetIndicatorAnchor>>;
  }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
      if (missing) {
        errorHandler.current?.(missing);
        return;
      }
      const crop = moriPetVisibleBounds(pixels, canvas.width, pet.version);
      const anchor = moriPetIndicatorAnchor(pixels, canvas.width);
      if (crop && anchor) setAtlas({ source: pet.image, image, crop, anchor });
    };
    image.src = pet.image;
    return () => {
      image.onerror = null;
      image.onload = null;
    };
  }, [pet.image, pet.version]);
  const row = look === null ? definition.row : 9 + Math.floor(look / 8);
  const column = look === null ? frame % definition.durations.length : look % 8;
  const indicatorSize = Math.max(12, Math.min(20, size * 0.25));
  const current = atlas?.source === pet.image ? atlas : undefined;
  const padding = Math.max(3, size * 0.045);
  const scale = current ? (size - padding * 2) / Math.max(current.crop.width, current.crop.height) : 0;
  const x = current ? (size - current.crop.width * scale) / 2 : 0;
  const y = current ? (size - current.crop.height * scale) / 2 : 0;
  const indicatorX = current
    ? Math.min(
        size - indicatorSize / 2 - 1,
        x + (current.anchor.x * MORI_PET_CELL_WIDTH - current.crop.x) * scale + indicatorSize * 0.2,
      )
    : 0;
  const indicatorY = current
    ? Math.max(indicatorSize / 2 + 1, y + (current.anchor.y * MORI_PET_CELL_HEIGHT - current.crop.y) * scale)
    : 0;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    const ratio = window.devicePixelRatio;
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    const context = canvas.getContext("2d");
    if (!context) {
      errorHandler.current?.("无法绘制宠物。");
      return;
    }
    context.scale(ratio, ratio);
    context.drawImage(
      current.image,
      column * MORI_PET_CELL_WIDTH + current.crop.x,
      row * MORI_PET_CELL_HEIGHT + current.crop.y,
      current.crop.width,
      current.crop.height,
      x,
      y,
      current.crop.width * scale,
      current.crop.height * scale,
    );
    if (!onHitMap) return;
    // Sample at CSS-pixel resolution: the main process uses screen DIP coordinates.
    const mask = document.createElement("canvas");
    mask.width = mask.height = Math.round(size);
    const maskContext = mask.getContext("2d", { willReadFrequently: true });
    if (!maskContext) {
      errorHandler.current?.("无法生成宠物点击范围。");
      return;
    }
    maskContext.drawImage(canvas, 0, 0, mask.width, mask.height);
    const bodyPixels = maskContext.getImageData(0, 0, mask.width, mask.height).data;
    const bodyAlpha = new Uint8Array(mask.width * mask.height);
    for (let i = 0; i < bodyAlpha.length; i++) bodyAlpha[i] = bodyPixels[i * 4 + 3] ?? 0;
    const bodyMap = { width: mask.width, height: mask.height, alpha: bodyAlpha };
    if (!indicator) {
      onHitMap(bodyMap, bodyMap);
      return;
    }
    if (indicator) {
      maskContext.save();
      maskContext.translate(indicatorX - indicatorSize / 2, indicatorY - indicatorSize / 2);
      maskContext.scale(indicatorSize / 24, indicatorSize / 24);
      maskContext.fill(new Path2D(BUBBLE_PATH));
      maskContext.restore();
    }
    const pixels = maskContext.getImageData(0, 0, mask.width, mask.height).data;
    const alpha = new Uint8Array(mask.width * mask.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3] ?? 0;
    onHitMap({ width: mask.width, height: mask.height, alpha }, bodyMap);
  }, [current, column, row, size, scale, x, y, indicator, indicatorX, indicatorY, indicatorSize, onHitMap]);
  return (
    <span className="mori-pet-sprite" aria-hidden="true" style={{ width: size, height: size }}>
      <canvas ref={canvasRef} className="mori-pet-frame" />
      {indicator && current ? (
        <svg
          aria-hidden="true"
          className={`mori-pet-indicator is-${indicator}`}
          viewBox="0 0 24 24"
          width={indicatorSize}
          height={indicatorSize}
          style={{
            left: indicatorX,
            top: indicatorY,
          }}
        >
          <path className="mori-pet-indicator-shell" d={BUBBLE_PATH} />
          {indicator === "error" ? (
            <path d="M12 6.5v4.5m0 3h.01" />
          ) : (
            <path d="M8 10.5h.01m3.99 0h.01m3.99 0h.01" />
          )}
        </svg>
      ) : null}
    </span>
  );
}
