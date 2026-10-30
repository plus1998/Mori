import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        <span>{t("moriUi.moriPetSettings.appearance")}</span>
        <select
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setDirection(null);
          }}
        >
          <option value="">{t("moriUi.moriPetSettings.default")}</option>
          {list?.pets.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name} · {item.key.startsWith("mori:") ? "已导入" : "Codex"} · v{item.version}
            </option>
          ))}
          {value && list && !list.pets.some((item) => item.key === value) ? (
            <option value={value}>{t("moriUi.moriPetSettings.unavailable")}{value}</option>
          ) : null}
        </select>
      </label>
      <div className="mori-pet-actions">
        <button type="button" disabled={busy} onClick={() => void importPet()}>
          {t("moriUi.moriPetSettings.import")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh().catch((error) => setError(String(error)))}
        >
          {t("moriUi.moriPetSettings.refresh")}
        </button>
      </div>
      <p className="mori-settings-hint">
        {t("moriUi.moriPetSettings.importHint")}
      </p>
      <label className="mori-pet-size">
        <span>
          {t("moriUi.moriPetSettings.size")} <strong>{size} px</strong>
        </span>
        <input
          type="range"
          min={MORI_PET_SIZE_MIN}
          max={MORI_PET_SIZE_MAX}
          step={8}
          value={size}
          onChange={(event) => onSizeChange(Number(event.target.value))}
        />
        <small>{t("moriUi.moriPetSettings.sizeHint")}</small>
      </label>
      {error ? (
        <p className="mori-error" role="alert">
          {error}
        </p>
      ) : null}
      {list?.errors.length ? (
        <p className="mori-error" role="alert">
          {t("moriUi.moriPetSettings.readErrors")}{list.errors.join("；")}
        </p>
      ) : null}
      {pet ? (
        <div className="mori-pet-preview">
          <MoriPetSprite
            pet={pet}
            animation={animation}
            direction={direction}
            size={size}
            onError={setError}
          />
          <div>
            <strong>{pet.name}</strong>
            <label>
              <span>{t("moriUi.moriPetSettings.preview")}</span>
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
                        {t("moriUi.moriPetSettings.look")} {angle}°
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
