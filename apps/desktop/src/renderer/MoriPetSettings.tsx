import { useCallback, useEffect, useState } from "react";
import { MORI_PET_SIZE_MAX, MORI_PET_SIZE_MIN } from "../shared/mori-assistant";
import {
  MORI_PET_ANIMATIONS,
  type MoriPetAnimation,
  type MoriPetAsset,
  type MoriPetList,
} from "../shared/mori-pet";
import { MoriPetSprite } from "./MoriPetSprite";
import { DEFAULT_MORI_PET } from "./mori-default-pet";

const labels: Record<MoriPetAnimation, string> = {
  idle: "待机",
  "running-right": "向右移动",
  "running-left": "向左移动",
  waving: "打招呼",
  jumping: "跳跃",
  failed: "失败",
  waiting: "等待回应",
  running: "工作中",
  review: "检查",
};

export function MoriPetSettings({
  value,
  onChange,
  size,
  onSizeChange,
}: {
  value: string;
  onChange(value: string): void;
  size: number;
  onSizeChange(size: number): void;
}) {
  const [list, setList] = useState<MoriPetList>();
  const [pet, setPet] = useState<MoriPetAsset>();
  const [animation, setAnimation] = useState<MoriPetAnimation>("idle");
  const [direction, setDirection] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!window.eco) throw new Error("桌面连接尚未就绪。");
    setList(await window.eco.moriPetsList());
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setError(String(error)));
  }, [refresh]);
  useEffect(() => {
    let active = true;
    setPet(value ? undefined : DEFAULT_MORI_PET);
    setError("");
    if (value && window.eco) {
      void window.eco
        .moriPetAsset(value)
        .then((next) => {
          if (active) {
            setPet(next);
            setError("");
          }
        })
        .catch((error) => {
          if (active) setError(error instanceof Error ? error.message : String(error));
        });
    }
    return () => {
      active = false;
    };
  }, [value]);
  const importPet = async () => {
    if (!window.eco) return;
    setBusy(true);
    setError("");
    try {
      const imported = await window.eco.moriPetsImport();
      if (imported) {
        await refresh();
        onChange(imported.key);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mori-pet-settings">
      <label>
        <span>悬浮形象</span>
        <select
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setDirection(null);
          }}
        >
          <option value="">默认 Mori</option>
          {list?.pets.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name} · {item.key.startsWith("mori:") ? "已导入" : "Codex"} · v{item.version}
            </option>
          ))}
          {value && list && !list.pets.some((item) => item.key === value) ? (
            <option value={value}>已选宠物不可用：{value}</option>
          ) : null}
        </select>
      </label>
      <div className="mori-pet-actions">
        <button type="button" disabled={busy} onClick={() => void importPet()}>
          导入宠物文件夹
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh().catch((error) => setError(String(error)))}
        >
          刷新
        </button>
      </div>
      <p className="mori-settings-hint">
        自动读取 Codex Pets；也可导入含 pet.json 与精灵图的文件夹。支持 v1 和 v2。
      </p>
      <label className="mori-pet-size">
        <span>
          悬浮大小 <strong>{size} px</strong>
        </span>
        <input
          type="range"
          min={MORI_PET_SIZE_MIN}
          max={MORI_PET_SIZE_MAX}
          step={8}
          value={size}
          onChange={(event) => onSizeChange(Number(event.target.value))}
        />
        <small>每个宠物单独保存，拖动预览后点击保存设置。</small>
      </label>
      {error ? (
        <p className="mori-error" role="alert">
          {error}
        </p>
      ) : null}
      {list?.errors.length ? (
        <p className="mori-error" role="alert">
          部分宠物无法读取：{list.errors.join("；")}
        </p>
      ) : null}
      {pet ? (
        <div className="mori-pet-preview">
          <MoriPetSprite
            pet={pet}
            animation={animation}
            direction={direction}
            size={size * 0.875}
            onError={setError}
          />
          <div>
            <strong>{pet.name}</strong>
            <label>
              <span>动作预览</span>
              <select
                value={direction === null ? animation : `look:${direction}`}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("look:")) {
                    setAnimation("idle");
                    setDirection(Number(value.slice(5)));
                  } else {
                    setDirection(null);
                    setAnimation(value as MoriPetAnimation);
                  }
                }}
              >
                {Object.keys(MORI_PET_ANIMATIONS).map((name) => (
                  <option key={name} value={name}>
                    {labels[name as MoriPetAnimation]}
                  </option>
                ))}
                {pet.version === 2
                  ? Array.from({ length: 16 }, (_, index) => index * 22.5).map((angle, index) => (
                      <option key={`look-${angle}`} value={`look:${index}`}>
                        视线 {angle}°
                      </option>
                    ))
                  : null}
              </select>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
