import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { MORI_PET_ANIMATIONS, type MoriPetAnimation, type MoriPetList } from "../shared/mori-pet";
import type { MoriAvatarSettings as AvatarSettings } from "../shared/mori-avatar";
import { SettingsButton, SettingsSelect } from "./components/SettingsControls";
import { MoriAvatar } from "./MoriAvatar";

function poses(t: (key: string) => string): Record<MoriPetAnimation, string> {
  return {
    idle: t("moriAvatar.idleRecommended"),
    waving: t("moriAvatar.wave"),
    "running-right": t("moriAvatar.moveRight"),
    "running-left": t("moriAvatar.moveLeft"),
    jumping: t("moriAvatar.jump"),
    failed: t("moriAvatar.failed"),
    waiting: t("moriAvatar.waitingForResponse"),
    running: t("moriAvatar.working"),
    review: t("moriAvatar.review"),
  };
}
const firstFrame = (petKey: string): AvatarSettings => ({ petKey, animation: "idle", frame: 0, zoom: 1 });

export function MoriAvatarSettings({
  value,
  onChange,
}: {
  value: AvatarSettings | null;
  onChange(value: AvatarSettings | null): void;
}) {
  const { t } = useTranslation();
  const [list, setList] = useState<MoriPetList>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setError("");
    try {
      setList(await window.eco!.moriPetsList());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const importPet = async () => {
    setBusy(true);
    setError("");
    try {
      const pet = await window.eco!.moriPetsImport();
      if (pet) {
        await refresh();
        onChange(firstFrame(pet.key));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mori-avatar-settings">
      <p className="mori-settings-hint">{t("moriAvatar.intro")}</p>
      <div className="mori-avatar-options" role="group" aria-label={t("moriAvatar.chooseAssistantAvatar")}>
        <button type="button" aria-pressed={!value} onClick={() => onChange(null)}>
          <MoriAvatar size={48} />
          <span>{t("moriAvatar.defaultMori")}</span>
        </button>
        {list?.pets.map((pet) => (
          <button
            type="button"
            key={pet.key}
            aria-pressed={value?.petKey === pet.key}
            onClick={() => onChange(firstFrame(pet.key))}
          >
            <MoriAvatar avatar={firstFrame(pet.key)} size={48} />
            <span>{pet.name}</span>
          </button>
        ))}
      </div>
      <div className="mori-pet-actions">
        <SettingsButton variant="secondary" type="button" disabled={busy} onClick={() => void importPet()}>
          {t("moriAvatar.importPet")}
        </SettingsButton>
        <SettingsButton variant="secondary" type="button" disabled={busy} onClick={() => void refresh()}>
          {t("moriAvatar.refreshList")}
        </SettingsButton>
      </div>
      {value ? (
        <div className="mori-avatar-editor">
          <div className="mori-avatar-previews" aria-label={t("moriAvatar.avatarPreview")}>
            <MoriAvatar avatar={value} size={60} />
            <MoriAvatar avatar={value} size={34} />
          </div>
          <label>
            {t("moriAvatar.animation")}
            <SettingsSelect
              value={value.animation}
              onChange={(event) =>
                onChange({ ...value, animation: event.target.value as MoriPetAnimation, frame: 0 })
              }
            >
              {Object.entries(poses(t)).map(([pose, label]) => (
                <option key={pose} value={pose}>
                  {label}
                </option>
              ))}
            </SettingsSelect>
          </label>
          <label>
            {t("moriAvatar.frame")}
            <SettingsSelect
              value={value.frame}
              onChange={(event) => onChange({ ...value, frame: Number(event.target.value) })}
            >
              {MORI_PET_ANIMATIONS[value.animation].durations.map((_, frame) => (
                <option key={frame} value={frame}>
                  {t("moriAvatar.frameNumber", { frame: frame + 1 })}
                </option>
              ))}
            </SettingsSelect>
          </label>
          <label>
            {t("moriAvatar.faceZoom", { zoom: value.zoom.toFixed(1) })}
            <input
              type="range"
              min={1}
              max={2.5}
              step={0.1}
              value={value.zoom}
              onChange={(event) => onChange({ ...value, zoom: Number(event.target.value) })}
            />
          </label>
        </div>
      ) : null}
      {value &&
      list &&
      value.petKey !== "builtin:mori" &&
      !list.pets.some((pet) => pet.key === value.petKey) ? (
        <p className="mori-error" role="alert">
          {t("moriAvatar.unavailable")}
        </p>
      ) : null}
      {error || list?.errors.length ? (
        <p className="mori-error" role="alert">
          {[error, ...(list?.errors ?? [])].filter(Boolean).join("；")}
        </p>
      ) : null}
    </div>
  );
}
