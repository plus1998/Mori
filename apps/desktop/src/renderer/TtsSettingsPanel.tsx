import { SettingsResourceList, SettingsResourceRow } from "./components/SettingsResourceList";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import "./capability-settings.css";
import { SettingsButton, SettingsInput, SettingsSelect } from "./components/SettingsControls";
import { SettingsPage, SettingsSection } from "./components/SettingsPage";
import { Switch } from "./components/Switch";
import type { TFunction } from "i18next";
import { Pencil, Plus, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { resolveProviderBrandLogo } from "../shared/provider-brand-logo";
import {
  defaultTtsEndpoint,
  defaultTtsModel,
  type TtsProfileSaveInput,
  type TtsProfileSnapshot,
  type TtsProvider,
  type TtsSettingsSnapshot,
} from "../shared/tts";

interface Props {
  settings: TtsSettingsSnapshot;
  onChange: (settings: TtsSettingsSnapshot) => void;
  onError: (message: string) => void;
}

function formFromProfile(profile: TtsProfileSnapshot): TtsProfileSaveInput {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
  };
}

function providerLabel(provider: TtsProvider, t: TFunction): string {
  if (provider === "gemini") return "Gemini";
  if (provider === "doubao") return t("settings.tts.providerDoubaoShort");
  return t("settings.tts.providerOpenAiCompatibleShort");
}

export function TtsSettingsPanel({ settings, onChange, onError }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(settings.activeProfileId);
  const selected = useMemo(
    () => settings.profiles.find((profile) => profile.id === selectedId),
    [selectedId, settings.profiles],
  );
  const [form, setForm] = useState<TtsProfileSaveInput>(() =>
    selected ? formFromProfile(selected) : newProfileForm("gemini"),
  );
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (selected) setForm(formFromProfile(selected));
  }, [selected]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function choose(profile: TtsProfileSnapshot) {
    setSelectedId(profile.id);
    setForm(formFromProfile(profile));
    setEditorOpen(true);
  }

  function startNewProfile() {
    setSelectedId("");
    setForm(newProfileForm("gemini"));
    setEditorOpen(true);
  }

  return (
    <SettingsPage
      className="image-generation-settings capability-settings-page"
      title={t("settings.tts.title")}
      description={t("settings.tts.pageDesc")}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("settings.tts.masterTitle")}
          description={t("settings.tts.masterHint")}
          control={(controlProps) => (
            <Switch
              {...controlProps}
              checked={settings.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void run(async () => {
                  if (!window.eco) throw new Error(t("settings.tts.desktopOnly"));
                  onChange(await window.eco.saveTtsEnabled(checked));
                })
              }
            />
          )}
        />
      </SettingsGroup>

      {!settings.apiKeyEncryptionAvailable ? (
        <p className="browser-settings-error">{t("settings.tts.encryptionUnavailable")}</p>
      ) : null}

      <SettingsSection
        title={t("settings.tts.profiles")}
        description={
          <>
            {t("settings.tts.profileCount", { count: settings.profiles.length })}
            {settings.activeProfileId ? t("settings.tts.profileActiveSuffix") : ""}
          </>
        }
        actions={
          <>
            <SettingsButton variant="primary" type="button" disabled={busy} onClick={startNewProfile}>
              <Plus size={15} aria-hidden />
              {t("settings.tts.addProfile")}
            </SettingsButton>
          </>
        }
      >
        {settings.profiles.length === 0 ? (
          <div className="image-generation-profile-empty">
            <Volume2 size={22} />
            <strong>{t("settings.tts.emptyTitle")}</strong>
            <small>{t("settings.tts.emptyHint")}</small>
            <SettingsButton variant="primary" type="button" disabled={busy} onClick={startNewProfile}>
              <Plus size={15} />
              {t("settings.tts.addProfile")}
            </SettingsButton>
          </div>
        ) : (
          <SettingsResourceList>
            {settings.profiles.map((profile) => {
              const active = settings.activeProfileId === profile.id;
              const brand = resolveProviderBrandLogo({
                name: profile.name,
                model: profile.model,
                protocol: profile.provider,
                endpoint: profile.baseUrl,
              });
              return (
                <SettingsResourceRow
                  key={profile.id}
                  name={profile.name}
                  description={
                    <>
                      {providerLabel(profile.provider, t)} · {profile.model}
                    </>
                  }
                  icon={
                    brand ? <img src={brand.iconSrc} alt="" aria-hidden /> : <Volume2 size={17} aria-hidden />
                  }
                  metadata={
                    <>
                      <span>Base URL：{profile.baseUrl}</span>
                    </>
                  }
                  status={
                    <button
                      type="button"
                      className="settings-ui-resource-state"
                      aria-pressed={active}
                      disabled={active || busy}
                      title={t(active ? "settings.tts.status.active" : "settings.tts.activate")}
                      aria-label={t(active ? "settings.tts.status.active" : "settings.tts.activate")}
                      onClick={() =>
                        void run(async () => {
                          if (!window.eco) throw new Error(t("settings.tts.desktopOnly"));
                          onChange(await window.eco.activateTtsProfile(profile.id));
                        })
                      }
                    >
                      <i aria-hidden />
                      {t(active ? "settings.tts.status.active" : "settings.tts.status.disabled")}
                    </button>
                  }
                  actions={
                    <>
                      <SettingsButton
                        variant="secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => choose(profile)}
                      >
                        <Pencil size={14} />
                        {t("common.edit")}
                      </SettingsButton>
                    </>
                  }
                />
              );
            })}
          </SettingsResourceList>
        )}
      </SettingsSection>

      {editorOpen
        ? createPortal(
            <div className="settings-modal-backdrop">
              <button
                type="button"
                className="settings-modal-backdrop-close"
                aria-label={t("common.close")}
                disabled={busy}
                onClick={() => setEditorOpen(false)}
                tabIndex={-1}
              />
              <form
                className="settings-modal settings-modal-provider-editor image-generation-profile-modal capability-settings-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="image-generation-profile-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    if (!window.eco) throw new Error(t("settings.tts.desktopOnly"));
                    const saved = await window.eco.saveTtsProfile(form);
                    const next = await window.eco.getTtsSettings();
                    onChange(next);
                    setSelectedId(saved.id);
                    setEditorOpen(false);
                  });
                }}
              >
                <header className="settings-modal-header">
                  <div>
                    <h2 className="settings-modal-title" id="image-generation-profile-title">
                      {t(selected ? "settings.tts.editProfileTitle" : "settings.tts.addProfileTitle")}
                    </h2>
                    <p className="image-generation-profile-modal-subtitle">
                      {t("settings.tts.editorSubtitle")}
                    </p>
                  </div>
                  <SettingsButton
                    variant="ghost"
                    type="button"
                    aria-label={t("common.close")}
                    disabled={busy}
                    onClick={() => setEditorOpen(false)}
                  >
                    <X size={17} />
                  </SettingsButton>
                </header>
                <div className="settings-modal-body image-generation-profile-modal-body">
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">{t("settings.tts.profileName")}</span>
                    <SettingsInput
                      value={form.name}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">{t("settings.tts.provider")}</span>
                    <SettingsSelect
                      value={form.provider}
                      disabled={busy}
                      onChange={(event) => {
                        const provider = event.target.value as TtsProvider;
                        setForm({
                          ...form,
                          provider,
                          baseUrl: defaultTtsEndpoint(provider),
                          model: defaultTtsModel(provider),
                        });
                      }}
                    >
                      <option value="gemini">{t("settings.tts.providerGemini")}</option>
                      <option value="openai_compatible">{t("settings.tts.providerOpenAiCompatible")}</option>
                      <option value="doubao">{t("settings.tts.providerDoubao")}</option>
                    </SettingsSelect>
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">Base URL</span>
                    <SettingsInput
                      type="url"
                      value={form.baseUrl}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">{t("settings.tts.model")}</span>
                    <SettingsInput
                      value={form.model}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, model: event.target.value })}
                    />
                    {form.provider === "doubao" ? (
                      <small className="image-generation-profile-modal-subtitle">
                        {t("settings.tts.doubaoModelHint")}
                      </small>
                    ) : null}
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">API Key</span>
                    <SettingsInput
                      type="password"
                      value={form.apiKey ?? ""}
                      disabled={busy || !settings.apiKeyEncryptionAvailable}
                      placeholder={selected?.hasApiKey ? t("settings.tts.keyConfigured") : ""}
                      onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                    />
                  </label>
                </div>
                <footer className="settings-modal-footer">
                  <SettingsButton
                    variant="secondary"
                    size="dialog"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditorOpen(false)}
                  >
                    {t("common.cancel")}
                  </SettingsButton>
                  <div className="settings-modal-footer-actions">
                    {selected ? (
                      <SettingsButton
                        variant="danger"
                        size="dialog"
                        className="image-generation-danger-button"
                        type="button"
                        disabled={
                          busy || settings.activeProfileId === selected.id || settings.profiles.length <= 1
                        }
                        onClick={() =>
                          void run(async () => {
                            if (!window.eco) throw new Error(t("settings.tts.desktopOnly"));
                            onChange(await window.eco.deleteTtsProfile(selected.id));
                            setSelectedId(settings.activeProfileId);
                            setEditorOpen(false);
                          })
                        }
                      >
                        <Trash2 size={14} />
                        {t("common.delete")}
                      </SettingsButton>
                    ) : null}
                    <SettingsButton variant="primary" size="dialog" type="submit" disabled={busy}>
                      {t(busy ? "settings.tts.saving" : "common.save")}
                    </SettingsButton>
                  </div>
                </footer>
              </form>
            </div>,
            document.body,
          )
        : null}
    </SettingsPage>
  );
}

function newProfileForm(provider: TtsProvider): TtsProfileSaveInput {
  return {
    name: "",
    provider,
    baseUrl: defaultTtsEndpoint(provider),
    model: defaultTtsModel(provider),
    apiKey: "",
  };
}
