import { SettingsResourceList, SettingsResourceRow } from "./components/SettingsResourceList";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import "./capability-settings.css";
import { SettingsButton, SettingsInput, SettingsSelect } from "./components/SettingsControls";
import { SettingsPage, SettingsSection } from "./components/SettingsPage";
import { Switch } from "./components/Switch";
import type { TFunction } from "i18next";
import { Image, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import {
  isImageGenerationLoginProvider,
  type ImageGenerationSource,
  type ImageGenerationLoginRoute,
  defaultImageGenerationEndpoint,
  defaultImageGenerationModel,
  defaultSupportsImageToImage,
  type ImageGenerationProfileSaveInput,
  type ImageGenerationProfileSnapshot,
  type ImageGenerationProvider,
  type ImageGenerationSettingsSnapshot,
} from "../shared/image-generation";
import { resolveProviderBrandLogo } from "../shared/provider-brand-logo";
import { ImageGenerationLoginSettings } from "./ImageGenerationLoginSettings";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface Props {
  settings: ImageGenerationSettingsSnapshot;
  onChange: (settings: ImageGenerationSettingsSnapshot) => void;
  onError: (message: string) => void;
  onManageAccounts?: () => void;
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
    chatModel: profile.chatModel,
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
  onManageAccounts,
  centerServerSyncVisible = false,
  onSyncDomain,
}: Props) {
  const { t } = useTranslation();
  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
  const login = activeProfile && isImageGenerationLoginProvider(activeProfile.provider);
  const apiProfiles = settings.profiles.filter(
    (profile) => !isImageGenerationLoginProvider(profile.provider),
  );
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
    <SettingsPage
      className="image-generation-settings capability-settings-page"
      title={t("settings.imageGeneration.title")}
      description={t("settings.imageGeneration.pageDesc")}
      actions={
        <>
          {onSyncDomain ? (
            <SettingsSyncControl
              domain="imageGeneration"
              visible={centerServerSyncVisible}
              disabled={busy}
              onSync={onSyncDomain}
            />
          ) : null}
        </>
      }
    >
      <SettingsGroup>
        <SettingsRow
          label={t("settings.imageGeneration.masterTitle")}
          description={t("settings.imageGeneration.masterHint")}
          control={(controlProps) => (
            <Switch
              {...controlProps}
              checked={settings.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void run(async () => {
                  if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                  onChange(await window.eco.saveImageGenerationEnabled(checked));
                })
              }
            />
          )}
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={t("settings.imageGeneration.source")}
          control={(controlProps) => (
            <SettingsSelect
              {...controlProps}
              variant="inline"
              value={login ? "chatgpt_login" : "api"}
              disabled={busy}
              onChange={(event) => {
                const source = event.target.value as ImageGenerationSource;
                void run(async () => {
                  if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                  onChange(await window.eco.selectImageGenerationSource({ source }));
                });
              }}
            >
              <option value="api">API</option>
              <option value="chatgpt_login">ChatGPT Login</option>
            </SettingsSelect>
          )}
        />
      </SettingsGroup>

      {login ? (
        <ImageGenerationLoginSettings
          profile={activeProfile}
          busy={busy}
          onRouteChange={(route: ImageGenerationLoginRoute) =>
            void run(async () => {
              if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
              onChange(await window.eco.selectImageGenerationSource({ source: "chatgpt_login", route }));
            })
          }
          onChatModelChange={(chatModel) =>
            void run(async () => {
              if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
              await window.eco.saveImageGenerationProfile({
                ...formFromProfile(activeProfile),
                chatModel,
              });
              onChange(await window.eco.getImageGenerationSettings());
            })
          }
          onImageModelChange={(model) =>
            void run(async () => {
              if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
              await window.eco.saveImageGenerationProfile({
                ...formFromProfile(activeProfile),
                model,
              });
              onChange(await window.eco.getImageGenerationSettings());
            })
          }
          onImageEditingChange={(checked) =>
            void run(async () => {
              if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
              await window.eco.saveImageGenerationProfile({
                ...formFromProfile(activeProfile),
                supportsImageToImage: checked,
              });
              onChange(await window.eco.getImageGenerationSettings());
            })
          }
          onPoolChange={() =>
            void run(async () => {
              if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
              onChange(await window.eco.getImageGenerationSettings());
            })
          }
          onError={onError}
          {...(onManageAccounts ? { onManageAccounts } : {})}
        />
      ) : (
        <>
          {!settings.apiKeyEncryptionAvailable ? (
            <p className="browser-settings-error">{t("settings.imageGeneration.encryptionUnavailable")}</p>
          ) : null}

          {activeProfile && !activeProfile.hasApiKey ? (
            <p className="browser-settings-error" role="status">
              {t("settings.imageGeneration.apiKeyMissing")}
            </p>
          ) : null}
          <SettingsSection
            title={t("settings.imageGeneration.profiles")}
            description={
              <>
                {t("settings.imageGeneration.profileCount", { count: apiProfiles.length })}
                {activeProfile ? t("settings.imageGeneration.profileActiveSuffix") : ""}
              </>
            }
            actions={
              <>
                <SettingsButton variant="primary" type="button" disabled={busy} onClick={startNewProfile}>
                  <Plus size={15} aria-hidden />
                  {t("settings.imageGeneration.addProfile")}
                </SettingsButton>
              </>
            }
          >
            {apiProfiles.length === 0 ? (
              <div className="image-generation-profile-empty">
                <Image size={22} />
                <strong>{t("settings.imageGeneration.emptyTitle")}</strong>
                <small>{t("settings.imageGeneration.emptyHint")}</small>
                <SettingsButton variant="primary" type="button" disabled={busy} onClick={startNewProfile}>
                  <Plus size={15} />
                  {t("settings.imageGeneration.addProfile")}
                </SettingsButton>
              </div>
            ) : (
              <SettingsResourceList>
                {apiProfiles.map((profile) => {
                  const active = settings.activeProfileId === profile.id;
                  const brand = resolveProviderBrandLogo({
                    name: profile.name,
                    model: profile.model,
                    protocol: profile.provider,
                    endpoint: profile.endpoint,
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
                        brand ? (
                          <img src={brand.iconSrc} alt="" aria-hidden />
                        ) : (
                          <Image size={17} aria-hidden />
                        )
                      }
                      metadata={
                        <>
                          <span>{t("settings.imageGeneration.baseUrlValue", { url: profile.endpoint })}</span>
                          <span>
                            {t(
                              profile.supportsImageToImage
                                ? "settings.imageGeneration.profileSupportsImageToImage"
                                : "settings.imageGeneration.profileTextToImageOnly",
                            )}
                          </span>
                        </>
                      }
                      status={
                        <button
                          type="button"
                          className="settings-ui-resource-state"
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
        </>
      )}

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
                      {t("settings.imageGeneration.editorSubtitle")}
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
                    <span className="settings-ui-field-label">
                      {t("settings.imageGeneration.profileName")}
                    </span>
                    <SettingsInput
                      value={form.name}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      autoFocus
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">{t("settings.imageGeneration.provider")}</span>
                    <SettingsSelect
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
                    </SettingsSelect>
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">Base URL</span>
                    <SettingsInput
                      type="url"
                      value={form.endpoint}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">{t("settings.imageGeneration.model")}</span>
                    <SettingsInput
                      value={form.model}
                      disabled={busy}
                      required
                      onChange={(event) => setForm({ ...form, model: event.target.value })}
                    />
                  </label>
                  <label className="settings-form-field settings-form-field-checkbox">
                    <span className="settings-ui-field-label">
                      {t("settings.imageGeneration.supportsImageToImage")}
                    </span>
                    <Switch
                      checked={form.supportsImageToImage ?? false}
                      disabled={busy}
                      aria-label={t("settings.imageGeneration.supportsImageToImage")}
                      onCheckedChange={(checked) => setForm({ ...form, supportsImageToImage: checked })}
                    />
                    <small className="settings-ui-field-hint">
                      {t("settings.imageGeneration.supportsImageToImageHint")}
                    </small>
                  </label>
                  <label className="settings-form-field">
                    <span className="settings-ui-field-label">API Key</span>
                    <SettingsInput
                      type="password"
                      value={form.apiKey ?? ""}
                      disabled={busy || !settings.apiKeyEncryptionAvailable}
                      placeholder={selected?.hasApiKey ? t("settings.imageGeneration.keyConfigured") : ""}
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
                            if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
                            onChange(await window.eco.deleteImageGenerationProfile(selected.id));
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
                      {t(busy ? "settings.imageGeneration.saving" : "common.save")}
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
