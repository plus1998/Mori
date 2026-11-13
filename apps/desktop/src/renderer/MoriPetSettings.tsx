import { Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MORI_PET_SIZE_MAX, MORI_PET_SIZE_MIN } from "../shared/mori-assistant";
import {
  MORI_PET_ANIMATIONS,
  type MoriPetAnimation,
  type MoriPetAsset,
  type MoriPetList,
} from "../shared/mori-pet";
import {
  DEFAULT_MORI_PET_ACTIONS,
  type MoriPetAction,
  type MoriPetActionOverrides,
  type MoriPetActionState,
  moriPetAction,
} from "../shared/mori-pet-actions";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { SettingsButton } from "./components/SettingsControls";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import { MoriPetSprite } from "./MoriPetSprite";
import { DEFAULT_MORI_PET } from "./mori-default-pet";

export function MoriPetSettings({
  value,
  onChange,
  size,
  onSizeChange,
  actions,
  onActionsChange,
}: {
  value: string;
  onChange(value: string): void;
  size: number;
  onSizeChange(size: number): void;
  actions: MoriPetActionOverrides;
  onActionsChange(actions: MoriPetActionOverrides): void;
}) {
  const { t } = useTranslation();
  const [list, setList] = useState<MoriPetList>();
  const [pet, setPet] = useState<MoriPetAsset>();
  const [animation, setAnimation] = useState<MoriPetAnimation>("idle");
  const [direction, setDirection] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewState, setPreviewState] = useState<MoriPetActionState>();
  const previewAction = (action: MoriPetAction, state: MoriPetActionState) => {
    setAnimation(action === "look" ? "idle" : action);
    setDirection(action === "look" ? 0 : null);
    setPreviewState(state);
  };
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
        <ComposerFieldSelect
          aria-label={t("moriUi.moriPetSettings.appearance")}
          value={value}
          onChange={(value) => {
            onChange(value);
            setDirection(null);
            setAnimation("idle");
            setPreviewState(undefined);
          }}
        >
          <option value="">{t("moriUi.moriPetSettings.default")}</option>
          {list?.pets.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name} · {item.key.startsWith("mori:") ? "已导入" : "Codex"} · v{item.version}
            </option>
          ))}
          {value && list && !list.pets.some((item) => item.key === value) ? (
            <option value={value}>
              {t("moriUi.moriPetSettings.unavailable")}
              {value}
            </option>
          ) : null}
        </ComposerFieldSelect>
      </label>
      <div className="mori-pet-actions">
        <SettingsButton variant="secondary" type="button" disabled={busy} onClick={() => void importPet()}>
          {t("moriUi.moriPetSettings.import")}
        </SettingsButton>
        <SettingsButton
          variant="secondary"
          type="button"
          disabled={busy}
          onClick={() => void refresh().catch((error) => setError(String(error)))}
        >
          {t("moriUi.moriPetSettings.refresh")}
        </SettingsButton>
      </div>
      <p className="mori-settings-hint">{t("moriUi.moriPetSettings.importHint")}</p>
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
          {t("moriUi.moriPetSettings.readErrors")}
          {list.errors.join("；")}
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
              <ComposerFieldSelect
                aria-label={t("moriUi.moriPetSettings.preview")}
                value={direction === null ? animation : `look:${direction}`}
                onChange={(value) => {
                  if (value.startsWith("look:")) {
                    setAnimation("idle");
                    setDirection(Number(value.slice(5)));
                  } else {
                    setDirection(null);
                    setAnimation(value as MoriPetAnimation);
                  }
                  setPreviewState(undefined);
                }}
              >
                {Object.keys(MORI_PET_ANIMATIONS).map((name) => (
                  <option key={name} value={name}>
                    {t(`moriUi.moriPetSettings.animation.${name}`)}
                  </option>
                ))}
                {pet.version === 2
                  ? Array.from({ length: 16 }, (_, index) => index * 22.5).map((angle, index) => (
                      <option key={`look-${angle}`} value={`look:${index}`}>
                        {t("moriUi.moriPetSettings.look")} {angle}°
                      </option>
                    ))
                  : null}
              </ComposerFieldSelect>
            </label>
          </div>
        </div>
      ) : null}
      <div className="mori-pet-action-settings">
        <div className="mori-pet-action-heading">
          <strong>{t("moriUi.moriPetSettings.stateActions")}</strong>
          <SettingsButton
            variant="secondary"
            disabled={!Object.keys(actions).length}
            onClick={() => {
              onActionsChange({});
              setAnimation("idle");
              setDirection(null);
              setPreviewState(undefined);
            }}
          >
            {t("moriUi.moriPetSettings.resetActions")}
          </SettingsButton>
        </div>
        <p className="mori-settings-hint">{t("moriUi.moriPetSettings.actionsHint")}</p>
        <SettingsGroup>
          {(Object.keys(DEFAULT_MORI_PET_ACTIONS) as MoriPetActionState[])
            .filter((state) => state !== "looking" || pet?.version === 2)
            .map((state) => (
              <SettingsRow
                key={state}
                className={`mori-pet-action-row${previewState === state ? " is-previewing" : ""}`}
                label={t(`moriUi.moriPetSettings.state.${state}`)}
                description={t(`moriUi.moriPetSettings.stateHint.${state}`)}
                stackControlOnNarrow
                control={(controlProps) => (
                  <div className="mori-pet-action-control">
                    <ComposerFieldSelect
                      {...controlProps}
                      value={actions[state] ?? ""}
                      onChange={(value) => {
                        const action = value as MoriPetAction | "";
                        const next = { ...actions };
                        if (action) next[state] = action;
                        else delete next[state];
                        onActionsChange(next);
                        previewAction(moriPetAction(state, next), state);
                      }}
                    >
                      <option value="">
                        {t("moriUi.moriPetSettings.defaultAction", {
                          action: t(`moriUi.moriPetSettings.animation.${DEFAULT_MORI_PET_ACTIONS[state]}`),
                        })}
                      </option>
                      {state === "looking" ? (
                        <option value="look">{t("moriUi.moriPetSettings.animation.look")}</option>
                      ) : null}
                      {Object.keys(MORI_PET_ANIMATIONS).map((name) => (
                        <option key={name} value={name}>
                          {t(`moriUi.moriPetSettings.animation.${name}`)}
                        </option>
                      ))}
                    </ComposerFieldSelect>
                    <SettingsButton
                      variant="ghost"
                      className="mori-pet-action-preview-button"
                      disabled={!pet}
                      aria-pressed={previewState === state}
                      aria-label={t("moriUi.moriPetSettings.previewState", {
                        state: t(`moriUi.moriPetSettings.state.${state}`),
                      })}
                      title={t("moriUi.moriPetSettings.previewState", {
                        state: t(`moriUi.moriPetSettings.state.${state}`),
                      })}
                      onClick={() => previewAction(moriPetAction(state, actions), state)}
                    >
                      <Play size={14} aria-hidden />
                    </SettingsButton>
                    <span className="mori-pet-action-thumbnail" aria-hidden="true">
                      {pet && previewState === state ? (
                        <MoriPetSprite
                          pet={pet}
                          animation={animation}
                          direction={direction}
                          size={36}
                          onError={setError}
                        />
                      ) : null}
                    </span>
                  </div>
                )}
              />
            ))}
        </SettingsGroup>
      </div>
    </div>
  );
}
