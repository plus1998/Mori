import { useEffect, useState } from "react";
import { MORI_PET_ANIMATIONS, type MoriPetAnimation, type MoriPetList } from "../shared/mori-pet";
import type { MoriAvatarSettings as AvatarSettings } from "../shared/mori-avatar";
import { SettingsButton, SettingsSelect } from "./components/SettingsControls";
import { MoriAvatar } from "./MoriAvatar";

const poses: Record<MoriPetAnimation, string> = {
  idle: "待机（推荐）", waving: "打招呼", "running-right": "向右移动", "running-left": "向左移动",
  jumping: "跳跃", failed: "失败", waiting: "等待回应", running: "工作中", review: "检查",
};
const firstFrame = (petKey: string): AvatarSettings => ({ petKey, animation: "idle", frame: 0, zoom: 1 });

export function MoriAvatarSettings({ value, onChange }: {
  value: AvatarSettings | null;
  onChange(value: AvatarSettings | null): void;
}) {
  const [list, setList] = useState<MoriPetList>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setError("");
    try { setList(await window.eco!.moriPetsList()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { void refresh(); }, []);
  const importPet = async () => {
    setBusy(true);
    setError("");
    try {
      const pet = await window.eco!.moriPetsImport();
      if (pet) { await refresh(); onChange(firstFrame(pet.key)); }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="mori-avatar-settings">
      <p className="mori-settings-hint">从宠物中选一帧作为聊天头像，可单独设置。待机第 1 帧通常最清晰。</p>
      <div className="mori-avatar-options" role="group" aria-label="选择助手头像">
        <button type="button" aria-pressed={!value} onClick={() => onChange(null)}>
          <MoriAvatar size={48} /><span>默认 Mori</span>
        </button>
        {list?.pets.map((pet) => (
          <button type="button" key={pet.key} aria-pressed={value?.petKey === pet.key}
            onClick={() => onChange(firstFrame(pet.key))}>
            <MoriAvatar avatar={firstFrame(pet.key)} size={48} />
            <span>{pet.name}</span>
          </button>
        ))}
      </div>
      <div className="mori-pet-actions">
        <SettingsButton variant="secondary" type="button" disabled={busy} onClick={() => void importPet()}>导入宠物</SettingsButton>
        <SettingsButton variant="secondary" type="button" disabled={busy} onClick={() => void refresh()}>刷新列表</SettingsButton>
      </div>
      {value ? (
        <div className="mori-avatar-editor">
          <div className="mori-avatar-previews" aria-label="头像预览">
            <MoriAvatar avatar={value} size={60} /><MoriAvatar avatar={value} size={34} />
          </div>
          <label>动作
            <SettingsSelect value={value.animation} onChange={(event) => onChange({ ...value, animation: event.target.value as MoriPetAnimation, frame: 0 })}>
              {Object.entries(poses).map(([pose, label]) => <option key={pose} value={pose}>{label}</option>)}
            </SettingsSelect>
          </label>
          <label>帧
            <SettingsSelect value={value.frame} onChange={(event) => onChange({ ...value, frame: Number(event.target.value) })}>
              {MORI_PET_ANIMATIONS[value.animation].durations.map((_, frame) => <option key={frame} value={frame}>第 {frame + 1} 帧</option>)}
            </SettingsSelect>
          </label>
          <label>放大头脸 · {value.zoom.toFixed(1)}×
            <input type="range" min={1} max={2.5} step={0.1} value={value.zoom}
              onChange={(event) => onChange({ ...value, zoom: Number(event.target.value) })} />
          </label>
        </div>
      ) : null}
      {value && list && value.petKey !== "builtin:mori" && !list.pets.some((pet) => pet.key === value.petKey) ? (
        <p className="mori-error" role="alert">所选头像宠物不可用，请重新导入或选择其他头像。</p>
      ) : null}
      {error || list?.errors.length ? <p className="mori-error" role="alert">{[error, ...(list?.errors ?? [])].filter(Boolean).join("；")}</p> : null}
    </div>
  );
}
