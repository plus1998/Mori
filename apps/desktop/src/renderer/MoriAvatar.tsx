import { useEffect, useState } from "react";
import { moriAvatarCrop, type MoriAvatarSettings } from "../shared/mori-avatar";
import { MORI_PET_CELL_HEIGHT, MORI_PET_CELL_WIDTH } from "../shared/mori-pet";
import { MoriIcon, type MoriIconMood } from "./MoriIcon";
import { DEFAULT_MORI_PET } from "./mori-default-pet";
import "./mori-avatar.css";

const atlases = new Map<string, Promise<{ image: HTMLImageElement; pixels: Uint8ClampedArray }>>();
function loadAtlas(key: string) {
  const cached = atlases.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const pet = key === "builtin:mori" ? DEFAULT_MORI_PET : await window.eco!.moriPetAsset(key);
    const image = new Image();
    image.src = pet.image;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法读取头像素材。");
    context.drawImage(image, 0, 0);
    return { image, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
  })();
  if (atlases.size >= 8) atlases.delete(atlases.keys().next().value!);
  atlases.set(key, pending);
  void pending.catch(() => { if (atlases.get(key) === pending) atlases.delete(key); });
  return pending;
}

export function MoriAvatar({ avatar, size = 34, mood = "idle", animated = false }: {
  avatar?: MoriAvatarSettings | null | undefined;
  size?: number;
  mood?: MoriIconMood;
  animated?: boolean;
}) {
  const [result, setResult] = useState<{ key: string; image?: string; error?: string }>();
  const petKey = avatar?.petKey;
  const animation = avatar?.animation ?? "idle";
  const frame = avatar?.frame ?? 0;
  const zoom = avatar?.zoom ?? 1;
  const key = JSON.stringify([petKey, animation, frame, zoom]);
  useEffect(() => {
    if (!petKey) return;
    let active = true;
    void loadAtlas(petKey).then(({ image, pixels }) => {
      const crop = moriAvatarCrop(pixels, image.naturalWidth, { petKey, animation, frame, zoom });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法绘制头像。");
      // Draw only this cell, including when the crop extends outside its edges.
      context.drawImage(image, crop.originX, crop.originY, MORI_PET_CELL_WIDTH, MORI_PET_CELL_HEIGHT,
        (crop.originX - crop.x) * 256 / crop.size, (crop.originY - crop.y) * 256 / crop.size,
        MORI_PET_CELL_WIDTH * 256 / crop.size, MORI_PET_CELL_HEIGHT * 256 / crop.size);
      if (active) setResult({ key, image: canvas.toDataURL("image/png") });
    }).catch((error: unknown) => {
      if (active) setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; };
  }, [petKey, animation, frame, zoom, key]);
  if (!avatar) return <MoriIcon size={size} mood={mood} animated={animated} />;
  const current = result?.key === key ? result : undefined;
  return (
    <span className={`mori-avatar${current?.error ? " has-error" : ""}`} style={{ width: size, height: size }}
      role="img" aria-label={current?.error ? `头像加载失败：${current.error}` : "助手头像"}
      title={current?.error}>
      {current?.image ? <img src={current.image} alt="" /> : current?.error ? "!" : null}
    </span>
  );
}
