import { ChevronRight, KeyRound, Mic, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import type { AsrApiMode, AsrProfileSaveInput, AsrProfileSnapshot, AsrProfilesSnapshot } from "../shared/ipc";
import { resolveProviderBrandLogo } from "../shared/provider-brand-logo";
import {
  isAsrInputDeviceAvailable,
  SYSTEM_DEFAULT_ASR_INPUT_DEVICE_ID,
  useAsrInputDevices,
} from "./asr-input-devices";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface AsrSettingsPanelProps {
  snapshot: AsrProfilesSnapshot;
  busy?: boolean;
  loadError?: string;
  onSave: (input: AsrProfileSaveInput) => Promise<AsrProfileSnapshot>;
  onDelete: (profileId: string) => Promise<void>;
  onActivate: (profileId: string) => Promise<void>;
  onInputDeviceChange: (deviceId: string) => Promise<void>;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

interface ProfileDraft {
  id?: string;
  name: string;
  endpoint: string;
  apiMode: AsrApiMode;
  model: string;
  systemPrompt: string;
  apiKey: string;
}

const emptyDraft: ProfileDraft = {
  name: "",
  endpoint: "",
  apiMode: "chat_completions",
  model: "",
  systemPrompt: "",
  apiKey: "",
};

export function resolveAsrLoadErrorDetail(
  loadError: string | undefined,
  unknownError: string,
): string | undefined {
  return loadError === undefined ? undefined : loadError || unknownError;
}

export function profileToDraft(profile: AsrProfileSnapshot): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    endpoint: profile.endpoint,
    apiMode: profile.apiMode,
    model: profile.model,
    systemPrompt: profile.systemPrompt,
    apiKey: "",
  };
}

export function isAsrProfileDraftDirty(
  draft: ProfileDraft,
  selected: AsrProfileSnapshot | undefined,
): boolean {
  if (!selected) {
    return Boolean(
      draft.name.trim() ||
        draft.endpoint.trim() ||
        draft.model.trim() ||
        draft.systemPrompt.trim() ||
        draft.apiKey.trim() ||
        draft.apiMode !== emptyDraft.apiMode,
    );
  }
  return (
    draft.name.trim() !== selected.name ||
    draft.endpoint.trim() !== selected.endpoint ||
    draft.apiMode !== selected.apiMode ||
    draft.model.trim() !== selected.model ||
    draft.systemPrompt !== selected.systemPrompt ||
    draft.apiKey.trim().length > 0
  );
}

export function profileStatusLine(
  profile: Pick<AsrProfileSnapshot, "apiMode" | "model">,
  labels: { notSet: string },
): string {
  return [
    profile.apiMode === "audio_transcriptions" ? "Audio Transcriptions" : "Chat Completions",
    profile.model.trim() || labels.notSet,
  ].join(" · ");
}

export function AsrSettingsPanel({
  snapshot,
  busy,
  loadError,
  onSave,
  onDelete,
  onActivate,
  onInputDeviceChange,
  centerServerSyncVisible = false,
  onSyncDomain,
}: AsrSettingsPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [editorError, setEditorError] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fallbackDeviceLabel = useCallback((index: number) => t("asr.inputDeviceNumber", { index }), [t]);
  const inputDevices = useAsrInputDevices(fallbackDeviceLabel);
  const selectedProfile = useMemo(
    () => snapshot.profiles.find((profile) => profile.id === draft?.id),
    [draft?.id, snapshot.profiles],
  );
  const dirty = draft ? isAsrProfileDraftDirty(draft, selectedProfile) : false;
  const activeProfile = snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId);
  const selectedDeviceAvailable = isAsrInputDeviceAvailable(
    snapshot.inputDeviceId ?? SYSTEM_DEFAULT_ASR_INPUT_DEVICE_ID,
    inputDevices.devices.map((device) => ({ ...device, kind: "audioinput" as const })),
  );
  const selectedDeviceLabel = (() => {
    const deviceId = snapshot.inputDeviceId ?? SYSTEM_DEFAULT_ASR_INPUT_DEVICE_ID;
    if (!deviceId) return t("asr.systemDefault");
    if (!selectedDeviceAvailable) return t("asr.inputDeviceUnavailable");
    return (
      inputDevices.devices.find((device) => device.deviceId === deviceId)?.label ?? t("asr.systemDefault")
    );
  })();
  const contextPromptNote =
    draft?.apiMode === "audio_transcriptions"
      ? t("asr.contextPromptNoteTranscriptions")
      : t("asr.contextPromptNote");

  function openEditor(next: ProfileDraft) {
    if (busy) return;
    setEditorError(undefined);
    setConfirmingDelete(false);
    setDraft(next);
  }

  function closeEditor() {
    setEditorError(undefined);
    setConfirmingDelete(false);
    setDraft(null);
  }

  async function save() {
    if (busy || !draft || !dirty) return;
    const name = draft.name.trim();
    if (!name) {
      setEditorError(t("asr.profileNameRequired"));
      return;
    }
    setEditorError(undefined);
    try {
      await onSave({
        ...(draft.id ? { id: draft.id } : {}),
        name,
        endpoint: draft.endpoint,
        apiMode: draft.apiMode,
        model: draft.model,
        systemPrompt: draft.systemPrompt,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
      });
      closeEditor();
    } catch (caught) {
      setEditorError(caught instanceof Error ? caught.message : t("asr.saveError"));
    }
  }

  async function remove() {
    if (!draft?.id || busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setEditorError(undefined);
      return;
    }
    setEditorError(undefined);
    try {
      await onDelete(draft.id);
      closeEditor();
    } catch (caught) {
      setEditorError(caught instanceof Error ? caught.message : t("asr.deleteError"));
    }
  }

  async function activate(profileId: string) {
    if (busy) return;
    try {
      await onActivate(profileId);
    } catch (caught) {
      setEditorError(caught instanceof Error ? caught.message : t("asr.activateError"));
    }
  }

  async function selectInputDevice(deviceId: string) {
    if (busy) return;
    try {
      await onInputDeviceChange(deviceId);
    } catch (caught) {
      setEditorError(caught instanceof Error ? caught.message : t("asr.inputDeviceSaveError"));
    }
  }

  return (
    <>
      <header className="settings-page-header browser-settings-header settings-page-header-with-action">
        <div>
          <h1>{t("asr.title")}</h1>
          <p className="settings-page-desc">{t("asr.pageSubtitle")}</p>
        </div>
        {onSyncDomain ? (
          <SettingsSyncControl
            domain="asr"
            visible={centerServerSyncVisible}
            disabled={busy}
            onSync={onSyncDomain}
          />
        ) : null}
      </header>

      <section className="browser-settings-card browser-settings-master asr-mic-card">
        <div className="browser-settings-master-glyph" aria-hidden>
          <Mic size={20} strokeWidth={1.75} />
        </div>
        <div className="browser-settings-master-copy">
          <strong>{t("asr.inputDevice")}</strong>
          <small>{t("asr.inputDeviceSubtitle")}</small>
        </div>
        <div className="asr-mic-control">
          <span className="asr-mic-select">
            <select
              value={snapshot.inputDeviceId ?? SYSTEM_DEFAULT_ASR_INPUT_DEVICE_ID}
              disabled={busy}
              aria-label={t("asr.inputSource")}
              onChange={(event) => void selectInputDevice(event.target.value)}
            >
              <option value={SYSTEM_DEFAULT_ASR_INPUT_DEVICE_ID}>{t("asr.systemDefault")}</option>
              {!selectedDeviceAvailable && snapshot.inputDeviceId && (
                <option value={snapshot.inputDeviceId}>{t("asr.inputDeviceUnavailable")}</option>
              )}
              {inputDevices.devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <ChevronRight size={15} aria-hidden />
          </span>
          <button
            type="button"
            className="settings-icon-button asr-icon-button"
            onClick={() => void inputDevices.refresh()}
            disabled={busy || inputDevices.refreshing}
            title={t("asr.refreshInputDevices")}
            aria-label={t("asr.refreshInputDevices")}
          >
            <RefreshCw size={15} className={inputDevices.refreshing ? "asr-voice-spinner" : undefined} />
          </button>
        </div>
      </section>

      {!selectedDeviceAvailable && snapshot.inputDeviceId && (
        <p className="asr-inline-alert" role="alert">
          {t("asr.inputDeviceUnavailableDetail")}
        </p>
      )}
      {inputDevices.error !== undefined && (
        <p className="asr-inline-alert" role="alert">
          {t("asr.inputDeviceLoadError", {
            detail: inputDevices.error || t("asr.loadErrorUnknown"),
          })}
        </p>
      )}

      <div className="asr-profile-console">
        <div className="asr-profile-toolbar">
          <div>
            <strong>{t("asr.profiles")}</strong>
            <span>
              {t("asr.profileCount", { count: snapshot.profiles.length })}
              {activeProfile ? t("asr.profileCountActiveSuffix") : ""}
            </span>
          </div>
          <button
            type="button"
            className="settings-primary-button asr-add-button"
            disabled={busy}
            onClick={() => openEditor(emptyDraft)}
          >
            <Plus size={15} aria-hidden />
            {t("asr.addProfile")}
          </button>
        </div>

        {snapshot.profiles.length === 0 ? (
          <div className="asr-profile-empty">
            <Mic size={22} aria-hidden />
            <strong>{t("asr.emptyTitle")}</strong>
            <small>{t("asr.emptyHint")}</small>
            <button
              type="button"
              className="settings-primary-button"
              disabled={busy}
              onClick={() => openEditor(emptyDraft)}
            >
              <Plus size={15} aria-hidden />
              {t("asr.addProfile")}
            </button>
          </div>
        ) : (
          <div className="asr-profile-cards">
            {snapshot.profiles.map((profile) => {
              const active = profile.id === snapshot.activeProfileId;
              const brand = resolveProviderBrandLogo({
                name: profile.name,
                model: profile.model,
                endpoint: profile.endpoint,
              });
              return (
                <article key={profile.id} className={`asr-profile-card${active ? " is-active" : ""}`}>
                  <div className="asr-profile-card-main">
                    <div className="asr-profile-card-icon">
                      {brand ? <img src={brand.iconSrc} alt="" aria-hidden /> : <Mic size={17} aria-hidden />}
                    </div>
                    <div className="asr-profile-card-identity">
                      <strong title={profile.name}>{profile.name}</strong>
                      <span className="asr-profile-card-subtitle">
                        <span className="asr-profile-card-subtitle-text">
                          {profileStatusLine(profile, { notSet: t("asr.notSet") })}
                        </span>
                        {/* A saved key is the normal case; only a missing key is worth surfacing. */}
                        {!profile.hasApiKey && (
                          <em className="asr-profile-card-warning">{t("asr.missingApiKey")}</em>
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`asr-profile-state${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      disabled={active || busy}
                      title={active ? t("asr.active") : t("asr.setActive")}
                      aria-label={active ? t("asr.active") : t("asr.setActive")}
                      onClick={() => void activate(profile.id)}
                    >
                      <i aria-hidden />
                      {active ? t("asr.active") : t("asr.inactive")}
                    </button>
                    <div className="asr-profile-card-actions">
                      <button
                        type="button"
                        className="asr-profile-action-secondary"
                        disabled={busy}
                        onClick={() => openEditor(profileToDraft(profile))}
                      >
                        <Pencil size={14} aria-hidden />
                        {t("asr.editProfileAction")}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {loadError !== undefined && (
        <p className="asr-inline-alert" role="alert">
          {t("asr.loadError", {
            detail: resolveAsrLoadErrorDetail(loadError, t("asr.loadErrorUnknown")),
          })}
        </p>
      )}
      {!draft && editorError && (
        <p className="asr-inline-alert" role="alert">
          {editorError}
        </p>
      )}

      {draft
        ? createPortal(
            <div className="settings-modal-backdrop">
              <button
                type="button"
                className="settings-modal-backdrop-close"
                aria-label={t("common.close")}
                disabled={busy}
                onClick={closeEditor}
                tabIndex={-1}
              />
              <form
                className="settings-modal asr-profile-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="asr-profile-modal-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <header className="settings-modal-header">
                  <div>
                    <h2 className="settings-modal-title" id="asr-profile-modal-title">
                      {draft.id ? t("asr.editProfile") : t("asr.newProfile")}
                    </h2>
                    <p className="asr-profile-modal-subtitle">{t("asr.editorSubtitle")}</p>
                  </div>
                  <button
                    type="button"
                    className="mcp-icon-button"
                    aria-label={t("common.close")}
                    disabled={busy}
                    onClick={closeEditor}
                  >
                    <X size={17} aria-hidden />
                  </button>
                </header>

                <div className="settings-modal-body asr-profile-modal-body">
                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("asr.profileName")}</span>
                    <input
                      className="settings-form-input"
                      value={draft.name}
                      onChange={(event) => {
                        setConfirmingDelete(false);
                        setDraft({ ...draft, name: event.target.value });
                      }}
                      disabled={busy}
                      required
                      placeholder={t("asr.profileNamePlaceholder")}
                      autoComplete="off"
                    />
                  </label>

                  <div className="settings-form-field">
                    <span className="settings-form-label">{t("asr.apiMode")}</span>
                    <div
                      className="settings-segmented-control asr-segmented"
                      role="group"
                      aria-label={t("asr.apiMode")}
                    >
                      <button
                        type="button"
                        aria-pressed={draft.apiMode === "chat_completions"}
                        className={draft.apiMode === "chat_completions" ? "active" : undefined}
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDraft({ ...draft, apiMode: "chat_completions" });
                        }}
                        disabled={busy}
                      >
                        {t("asr.apiModeChat")}
                      </button>
                      <button
                        type="button"
                        aria-pressed={draft.apiMode === "audio_transcriptions"}
                        className={draft.apiMode === "audio_transcriptions" ? "active" : undefined}
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDraft({ ...draft, apiMode: "audio_transcriptions" });
                        }}
                        disabled={busy}
                      >
                        {t("asr.apiModeTranscriptions")}
                      </button>
                    </div>
                    <small className="settings-form-hint">
                      {draft.apiMode === "audio_transcriptions"
                        ? t("asr.subtitleTranscriptions")
                        : t("asr.subtitleChat")}
                    </small>
                  </div>

                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("asr.baseUrl")}</span>
                    <input
                      className="settings-form-input"
                      value={draft.endpoint}
                      onChange={(event) => {
                        setConfirmingDelete(false);
                        setDraft({ ...draft, endpoint: event.target.value });
                      }}
                      disabled={busy}
                      placeholder="https://"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>

                  <label className="settings-form-field">
                    <span className="settings-form-label settings-form-label-row">
                      <span>{t("asr.apiKey")}</span>
                      {selectedProfile?.hasApiKey ? <em>{t("asr.saved")}</em> : null}
                    </span>
                    <span className="asr-secure-input">
                      <KeyRound size={15} aria-hidden />
                      <input
                        type="password"
                        value={draft.apiKey}
                        onChange={(event) => {
                          setConfirmingDelete(false);
                          setDraft({ ...draft, apiKey: event.target.value });
                        }}
                        placeholder={selectedProfile?.hasApiKey ? t("asr.keepKey") : t("asr.enterKey")}
                        autoComplete="off"
                        disabled={busy || !snapshot.apiKeyEncryptionAvailable}
                      />
                    </span>
                  </label>

                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("asr.model")}</span>
                    <input
                      className="settings-form-input"
                      value={draft.model}
                      onChange={(event) => {
                        setConfirmingDelete(false);
                        setDraft({ ...draft, model: event.target.value });
                      }}
                      disabled={busy}
                      placeholder="qwen3-asr-flash"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>

                  <label className="settings-form-field">
                    <span className="settings-form-label">{t("asr.contextPrompt")}</span>
                    <textarea
                      className="settings-form-input asr-profile-modal-textarea"
                      value={draft.systemPrompt}
                      onChange={(event) => {
                        setConfirmingDelete(false);
                        setDraft({ ...draft, systemPrompt: event.target.value });
                      }}
                      rows={4}
                      disabled={busy}
                    />
                    <small className="settings-form-hint">{contextPromptNote}</small>
                  </label>
                </div>

                {!snapshot.apiKeyEncryptionAvailable && (
                  <p className="asr-inline-alert" role="status">
                    {t("asr.encryptionUnavailable")}
                  </p>
                )}
                {editorError && (
                  <p className="asr-inline-alert" role="alert">
                    {editorError}
                  </p>
                )}

                <footer className="settings-modal-footer">
                  <button
                    type="button"
                    className="settings-modal-cancel"
                    disabled={busy}
                    onClick={closeEditor}
                  >
                    {t("common.cancel")}
                  </button>
                  <div className="settings-modal-footer-actions">
                    {draft.id ? (
                      confirmingDelete ? (
                        <div className="asr-delete-confirm" role="group" aria-label={t("asr.deleteConfirm")}>
                          <span>{t("asr.deleteConfirm")}</span>
                          <button
                            type="button"
                            className="settings-danger-button"
                            disabled={busy}
                            onClick={() => void remove()}
                          >
                            {t("asr.deleteConfirmAction")}
                          </button>
                          <button
                            type="button"
                            className="settings-text-button"
                            disabled={busy}
                            onClick={() => setConfirmingDelete(false)}
                          >
                            {t("asr.deleteCancel")}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="settings-secondary-button asr-delete-text"
                          disabled={
                            busy || draft.id === snapshot.activeProfileId || snapshot.profiles.length <= 1
                          }
                          onClick={() => void remove()}
                        >
                          <Trash2 size={14} aria-hidden />
                          {t("asr.deleteProfile")}
                        </button>
                      )
                    ) : null}
                    <button type="submit" className="settings-primary-button" disabled={busy || !dirty}>
                      {busy ? t("asr.saving") : t("common.save")}
                    </button>
                  </div>
                </footer>
              </form>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
