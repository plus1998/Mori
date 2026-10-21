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
    <div className="image-generation-settings">
      <header className="settings-page-header browser-settings-header settings-page-header-with-action">
        <div>
          <h1>{t("settings.tts.title")}</h1>
          <p className="settings-page-desc">{t("settings.tts.pageDesc")}</p>
        </div>
      </header>
      <section className="browser-settings-card browser-settings-master">
        <div className="browser-settings-master-glyph" aria-hidden>
          <Volume2 size={20} strokeWidth={1.75} />
        </div>
        <div className="browser-settings-master-copy">
          <strong>{t("settings.tts.masterTitle")}</strong>
          <small>{t("settings.tts.masterHint")}</small>
        </div>
        <span className={`image-generation-enabled-badge ${settings.enabled ? "is-enabled" : "is-disabled"}`}>
          <i />
          {t(settings.enabled ? "settings.tts.status.enabled" : "settings.tts.status.disabled")}
        </span>
        <label className="composer-switch browser-settings-switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            aria-label={t("settings.tts.masterTitle")}
            onChange={(event) =>
              void run(async () => {
                if (!window.eco) throw new Error(t("settings.tts.desktopOnly"));
                onChange(await window.eco.saveTtsEnabled(event.target.checked));
              })
            }
          />
          <span className="composer-switch-track" aria-hidden />
        </label>
      </section>

      {!settings.apiKeyEncryptionAvailable ? (
        <p className="browser-settings-error">{t("settings.tts.encryptionUnavailable")}</p>
      ) : null}

      <div className="image-generation-profile-console">
        <div className="image-generation-profile-toolbar">
          <div>
            <strong>{t("settings.tts.profiles")}</strong>
            <span>
              {t("settings.tts.profileCount", { count: settings.profiles.length })}
              {settings.activeProfileId ? t("settings.tts.profileActiveSuffix") : ""}
            </span>
          </div>
          <button type="button" className="settings-primary-button" disabled={busy} onClick={startNewProfile}>
            <Plus size={15} aria-hidden />
            {t("settings.tts.addProfile")}
          </button>
        </div>

        {settings.profiles.length === 0 ? (
          <div className="image-generation-profile-empty">
            <Volume2 size={22} />
            <strong>{t("settings.tts.emptyTitle")}</strong>
            <small>{t("settings.tts.emptyHint")}</small>
            <button
              type="button"
              className="settings-primary-button"
              disabled={busy}
              onClick={startNewProfile}
            >
              <Plus size={15} />
              {t("settings.tts.addProfile")}
            </button>
          </div>
        ) : (
          <div className="image-generation-profile-cards">
            {settings.profiles.map((profile) => {
              const active = settings.activeProfileId === profile.id;
              const brand = resolveProviderBrandLogo({
                name: profile.name,
                model: profile.model,
                protocol: profile.provider,
                endpoint: profile.baseUrl,
              });
              return (
                <article
                  key={profile.id}
                  className={`image-generation-profile-card${active ? " is-active" : ""}`}
                >
                  <div className="image-generation-profile-card-main">
                    <div className="image-generation-profile-card-icon">
                      {brand ? (
                        <img src={brand.iconSrc} alt="" aria-hidden />
                      ) : (
                        <Volume2 size={17} aria-hidden />
                      )}
                    </div>
                    <div className="image-generation-profile-card-identity">
                      <strong title={profile.name}>{profile.name}</strong>
                      <span>
                        {providerLabel(profile.provider, t)} · {profile.model}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`image-generation-profile-status${active ? " is-active" : ""}`}
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
                    <div className="image-generation-profile-card-actions">
                      <button
                        type="button"
                        className="image-generation-profile-action-secondary"
                        disabled={busy}
                        onClick={() => choose(profile)}
                      >
                        <Pencil size={14} />
                        {t("common.edit")}
                      </button>
                    </div>
                  </div>
                  <div className="image-generation-profile-card-meta">
                    <span>Base URL：{profile.baseUrl}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

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
                className="settings-modal settings-modal-provider-editor image-generation-profile-modal"
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
                  <button
                    type="button"
                    className="mcp-icon-button"
                    aria-label={t("common.close")}
                    disabled={busy}
                    onClick={() => setEditorOpen(false)}
                  >
                    <X size={17} />
                  </button>
                </header>
                <div className="settings-modal-body image-generation-profile-modal-body">
                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("settings.tts.profileName")}</span>
                    <input
                      className="settings-form-input"
                      value={form.name}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("settings.tts.provider")}</span>
                    <select
                      className="settings-form-input"
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
                    </select>
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-form-label">Base URL</span>
                    <input
                      className="settings-form-input"
                      type="url"
                      value={form.baseUrl}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("settings.tts.model")}</span>
                    <input
                      className="settings-form-input"
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
                    <span className="settings-form-label">API Key</span>
                    <input
                      className="settings-form-input"
                      type="password"
                      value={form.apiKey ?? ""}
                      disabled={busy || !settings.apiKeyEncryptionAvailable}
                      placeholder={selected?.hasApiKey ? t("settings.tts.keyConfigured") : ""}
                      onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                    />
                  </label>
                </div>
                <footer className="settings-modal-footer">
                  <button
                    type="button"
                    className="settings-modal-cancel"
                    disabled={busy}
                    onClick={() => setEditorOpen(false)}
                  >
                    {t("common.cancel")}
                  </button>
                  <div className="settings-modal-footer-actions">
                    {selected ? (
                      <button
                        type="button"
                        className="settings-secondary-button image-generation-danger-button"
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
                      </button>
                    ) : null}
                    <button type="submit" className="settings-primary-button" disabled={busy}>
                      {t(busy ? "settings.tts.saving" : "common.save")}
                    </button>
                  </div>
                </footer>
              </form>
            </div>,
            document.body,
          )
        : null}
    </div>
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
