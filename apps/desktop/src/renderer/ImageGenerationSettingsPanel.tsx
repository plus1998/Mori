import type { TFunction } from "i18next";
import { Image, Palette, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import {
  defaultImageGenerationEndpoint,
  defaultImageGenerationModel,
  defaultSupportsImageToImage,
  type ImageGenerationProfileSaveInput,
  type ImageGenerationProfileSnapshot,
  type ImageGenerationProvider,
  type ImageGenerationSettingsSnapshot,
} from "../shared/image-generation";
import { resolveProviderBrandLogo } from "../shared/provider-brand-logo";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface Props {
  settings: ImageGenerationSettingsSnapshot;
  onChange: (settings: ImageGenerationSettingsSnapshot) => void;
  onError: (message: string) => void;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

function formFromProfile(profile: ImageGenerationProfileSnapshot): ImageGenerationProfileSaveInput {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    endpoint: profile.endpoint,
    model: profile.model,
    supportsImageToImage: profile.supportsImageToImage,
  };
}

function providerLabel(provider: ImageGenerationProvider, t: TFunction): string {
  if (provider === "chatgpt_web") return t("settings.imageGeneration.providerChatgptWebShort");
  if (provider === "codex") return t("settings.imageGeneration.providerCodexShort");
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  return t("settings.imageGeneration.providerOpenAiCompatible");
}

export function ImageGenerationSettingsPanel({
  settings,
  onChange,
  onError,
  centerServerSyncVisible = false,
  onSyncDomain,
}: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(settings.activeProfileId);
  const selected = useMemo(
    () => settings.profiles.find((profile) => profile.id === selectedId),
    [selectedId, settings.profiles],
  );
  const [form, setForm] = useState<ImageGenerationProfileSaveInput>(() =>
    selected ? formFromProfile(selected) : newProfileForm("openai"),
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

  function choose(profile: ImageGenerationProfileSnapshot) {
    setSelectedId(profile.id);
    setForm(formFromProfile(profile));
    setEditorOpen(true);
  }

  function startNewProfile() {
    setSelectedId("");
    setForm(newProfileForm("openai"));
    setEditorOpen(true);
  }

  return (
    <div className="image-generation-settings">
      <header className="settings-page-header browser-settings-header settings-page-header-with-action">
        <div>
          <h1>{t("settings.imageGeneration.title")}</h1>
          <p className="settings-page-desc">{t("settings.imageGeneration.pageDesc")}</p>
        </div>
        {onSyncDomain ? (
          <SettingsSyncControl
            domain="imageGeneration"
            visible={centerServerSyncVisible}
            disabled={busy}
            onSync={onSyncDomain}
          />
        ) : null}
      </header>
      <section className="browser-settings-card browser-settings-master">
        <div className="browser-settings-master-glyph" aria-hidden>
          <Palette size={20} strokeWidth={1.75} />
        </div>
        <div className="browser-settings-master-copy">
          <strong>{t("settings.imageGeneration.masterTitle")}</strong>
          <small>{t("settings.imageGeneration.masterHint")}</small>
        </div>
        <span className={`image-generation-enabled-badge ${settings.enabled ? "is-enabled" : "is-disabled"}`}>
          <i />
          {t(
            settings.enabled
              ? "settings.imageGeneration.status.enabled"
              : "settings.imageGeneration.status.disabled",
          )}
        </span>
        <label className="composer-switch browser-settings-switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            aria-label={t("settings.imageGeneration.masterTitle")}
            onChange={(event) =>
              void run(async () => {
                if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                onChange(await window.eco.saveImageGenerationEnabled(event.target.checked));
              })
            }
          />
          <span className="composer-switch-track" aria-hidden />
        </label>
      </section>

      {!settings.apiKeyEncryptionAvailable ? (
        <p className="browser-settings-error">{t("settings.imageGeneration.encryptionUnavailable")}</p>
      ) : null}

      <div className="image-generation-profile-console">
        <div className="image-generation-profile-toolbar">
          <div>
            <strong>{t("settings.imageGeneration.profiles")}</strong>
            <span>
              {t("settings.imageGeneration.profileCount", { count: settings.profiles.length })}
              {settings.activeProfileId ? t("settings.imageGeneration.profileActiveSuffix") : ""}
            </span>
          </div>
          <button type="button" className="settings-primary-button" disabled={busy} onClick={startNewProfile}>
            <Plus size={15} aria-hidden />
            {t("settings.imageGeneration.addProfile")}
          </button>
        </div>

        {settings.profiles.length === 0 ? (
          <div className="image-generation-profile-empty">
            <Image size={22} />
            <strong>{t("settings.imageGeneration.emptyTitle")}</strong>
            <small>{t("settings.imageGeneration.emptyHint")}</small>
            <button
              type="button"
              className="settings-primary-button"
              disabled={busy}
              onClick={startNewProfile}
            >
              <Plus size={15} />
              {t("settings.imageGeneration.addProfile")}
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
                endpoint: profile.endpoint,
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
                        <Image size={17} aria-hidden />
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
                      title={t(
                        active
                          ? "settings.imageGeneration.status.active"
                          : "settings.imageGeneration.activate",
                      )}
                      aria-label={t(
                        active
                          ? "settings.imageGeneration.status.active"
                          : "settings.imageGeneration.activate",
                      )}
                      onClick={() =>
                        void run(async () => {
                          if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                          onChange(await window.eco.activateImageGenerationProfile(profile.id));
                        })
                      }
                    >
                      <i aria-hidden />
                      {t(
                        active
                          ? "settings.imageGeneration.status.active"
                          : "settings.imageGeneration.status.disabled",
                      )}
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
                    <span>
                      {profile.provider === "codex" || profile.provider === "chatgpt_web"
                        ? t("settings.imageGeneration.accountPoolHint")
                        : t("settings.imageGeneration.baseUrlValue", { url: profile.endpoint })}
                    </span>
                    <span>
                      {t(
                        profile.supportsImageToImage
                          ? "settings.imageGeneration.profileSupportsImageToImage"
                          : "settings.imageGeneration.profileTextToImageOnly",
                      )}
                    </span>
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
                    if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                    const saved = await window.eco.saveImageGenerationProfile(form);
                    const next = await window.eco.getImageGenerationSettings();
                    onChange(next);
                    setSelectedId(saved.id);
                    setEditorOpen(false);
                  });
                }}
              >
                <header className="settings-modal-header">
                  <div>
                    <h2 className="settings-modal-title" id="image-generation-profile-title">
                      {t(
                        selected
                          ? "settings.imageGeneration.editProfileTitle"
                          : "settings.imageGeneration.addProfileTitle",
                      )}
                    </h2>
                    <p className="image-generation-profile-modal-subtitle">
                      {t(
                        form.provider === "codex" || form.provider === "chatgpt_web"
                          ? "settings.imageGeneration.editorSubtitleAccount"
                          : "settings.imageGeneration.editorSubtitle",
                      )}
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
                    <span className="settings-form-label">{t("settings.imageGeneration.profileName")}</span>
                    <input
                      className="settings-form-input"
                      value={form.name}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      autoFocus
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("settings.imageGeneration.provider")}</span>
                    <select
                      className="settings-form-input"
                      value={form.provider}
                      disabled={busy}
                      onChange={(event) => {
                        const provider = event.target.value as ImageGenerationProvider;
                        setForm({
                          ...form,
                          provider,
                          endpoint: defaultImageGenerationEndpoint(provider),
                          model: defaultImageGenerationModel(provider),
                          supportsImageToImage: defaultSupportsImageToImage(provider),
                        });
                      }}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="gemini">Gemini</option>
                      <option value="openai_compatible">
                        {t("settings.imageGeneration.providerOpenAiCompatible")}
                      </option>
                      <option value="codex">{t("settings.imageGeneration.providerCodex")}</option>
                      <option value="chatgpt_web">{t("settings.imageGeneration.providerChatgptWeb")}</option>
                    </select>
                  </label>
                  {form.provider === "codex" || form.provider === "chatgpt_web" ? (
                    <p className="settings-form-hint">
                      {t("settings.imageGeneration.accountDrawingEnabledHint")}
                    </p>
                  ) : null}
                  <label className="settings-form-field">
                    <span className="settings-form-label">Base URL</span>
                    <input
                      className="settings-form-input"
                      type="url"
                      value={form.endpoint}
                      disabled={busy || form.provider === "codex" || form.provider === "chatgpt_web"}
                      required
                      onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("settings.imageGeneration.model")}</span>
                    <input
                      className="settings-form-input"
                      value={form.model}
                      disabled={busy || form.provider === "codex" || form.provider === "chatgpt_web"}
                      required
                      onChange={(event) => setForm({ ...form, model: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field settings-form-field-checkbox">
                    <span className="settings-form-label">
                      {t("settings.imageGeneration.supportsImageToImage")}
                    </span>
                    <label className="composer-switch">
                      <input
                        type="checkbox"
                        checked={form.supportsImageToImage ?? false}
                        disabled={busy}
                        aria-label={t("settings.imageGeneration.supportsImageToImage")}
                        onChange={(event) => setForm({ ...form, supportsImageToImage: event.target.checked })}
                      />
                      <span className="composer-switch-track" aria-hidden />
                    </label>
                    <small className="settings-form-hint">
                      {t("settings.imageGeneration.supportsImageToImageHint")}
                    </small>
                  </label>
                  {form.provider !== "codex" && form.provider !== "chatgpt_web" ? (
                    <label className="settings-form-field">
                      <span className="settings-form-label">API Key</span>
                      <input
                        className="settings-form-input"
                        type="password"
                        value={form.apiKey ?? ""}
                        disabled={busy || !settings.apiKeyEncryptionAvailable}
                        placeholder={selected?.hasApiKey ? t("settings.imageGeneration.keyConfigured") : ""}
                        onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                      />
                    </label>
                  ) : null}
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
                            if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                            onChange(await window.eco.deleteImageGenerationProfile(selected.id));
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
                      {t(busy ? "settings.imageGeneration.saving" : "common.save")}
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

function newProfileForm(provider: ImageGenerationProvider): ImageGenerationProfileSaveInput {
  return {
    name: "",
    provider,
    endpoint: defaultImageGenerationEndpoint(provider),
    model: defaultImageGenerationModel(provider),
    supportsImageToImage: defaultSupportsImageToImage(provider),
    apiKey: "",
  };
}
