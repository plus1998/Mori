import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IMAGE_GENERATION_CODEX_IMAGE_MODELS,
  type ImageGenerationLoginRoute,
  type ImageGenerationProfileSnapshot,
  type ImageGenerationChatModelOption,
} from "../shared/image-generation";
import { canUseOpenAIAccountCredentials, type OpenAIAccount } from "../shared/openai-account";
import { ModelFieldLabel } from "./ModelFieldLabel";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { SettingsButton, SettingsSelect } from "./components/SettingsControls";
import { SettingsSection } from "./components/SettingsPage";
import { SettingsResourceList, SettingsResourceRow } from "./components/SettingsResourceList";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import { Switch } from "./components/Switch";
import gptImage25FlareIcon from "./assets/image-generation-models/gpt-image-2.5-flare.png";
import gptImage25SunburstIcon from "./assets/image-generation-models/gpt-image-2.5-sunburst.png";
import gptImage26FlareIcon from "./assets/image-generation-models/gpt-image-2.6-flare.png";

const CODEX_IMAGE_MODEL_ICONS: Record<(typeof IMAGE_GENERATION_CODEX_IMAGE_MODELS)[number], string> = {
  "gpt-image-2.5-flare": gptImage25FlareIcon,
  "gpt-image-2.5-sunburst": gptImage25SunburstIcon,
  "gpt-image-2.6-flare": gptImage26FlareIcon,
};

interface Props {
  profile: ImageGenerationProfileSnapshot;
  busy: boolean;
  onRouteChange: (route: ImageGenerationLoginRoute) => void;
  onChatModelChange: (model: string) => void;
  onImageModelChange: (model: string) => void;
  onImageEditingChange: (checked: boolean) => void;
  onPoolChange: () => void;
  onManageAccounts?: () => void;
  onError: (message: string) => void;
}

export function ImageGenerationLoginSettings({
  profile,
  busy,
  onRouteChange,
  onChatModelChange,
  onImageModelChange,
  onImageEditingChange,
  onPoolChange,
  onManageAccounts,
  onError,
}: Props) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<OpenAIAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [savingId, setSavingId] = useState("");
  const [reload, setReload] = useState(0);
  const [chatModels, setChatModels] = useState<ImageGenerationChatModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState("");
  const [modelsReload, setModelsReload] = useState(0);
  const refreshRequested = useRef(false);
  const saving = useRef(false);
  const web = profile.provider === "chatgpt_web";
  const poolKey = accounts.filter((account) => account.imageGenerationEnabled)
    .map((account) => `${account.id}:${account.authState}`).join(",");

  useEffect(() => {
    if (web && loading) return;
    let disposed = false;
    let request = 0;
    const force = refreshRequested.current;
    refreshRequested.current = false;
    async function refreshModels() {
      const current = ++request;
      setModelsLoading(true);
      setChatModels([]);
      setModelsError("");
      try {
        if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
        if (web) {
          const catalog = force
            ? await window.eco.refreshImageGenerationWebModels()
            : await window.eco.getImageGenerationWebModels();
          if (!disposed && current === request) {
            setChatModels(catalog.models);
            setModelsError(catalog.lastError ?? "");
          }
          return;
        }
        const catalog = await window.eco.getCodexModelCatalog();
        if (!disposed && current === request) {
          setChatModels(catalog.models.filter((model) => !model.hidden));
          setModelsError(catalog.status.lastError ?? "");
        }
      } catch (error) {
        if (!disposed && current === request) {
          setChatModels([]);
          setModelsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!disposed && current === request) setModelsLoading(false);
      }
    }
    void refreshModels();
    const unsubscribe = web ? undefined : window.eco?.onThreadEvent((event) => {
      if (event && typeof event === "object" && "type" in event && event.type === "settings.updated")
        void refreshModels();
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [t, web, web && loading, web ? poolKey : "", modelsReload]);

  useEffect(() => {
    let disposed = false;
    let request = 0;
    async function refresh() {
      const current = ++request;
      setLoading(true);
      try {
        if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
        const result = await window.eco.openAIAccountsList();
        if (!disposed && current === request) {
          setAccounts(result);
          setLoadError("");
        }
      } catch (error) {
        if (!disposed && current === request)
          setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed && current === request) setLoading(false);
      }
    }
    void refresh();
    const unsubscribe = window.eco?.onOpenAIAccountsChanged(() => void refresh());
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [reload, t]);

  async function toggleAccount(accountId: string, enabled: boolean) {
    if (saving.current) return;
    saving.current = true;
    setSavingId(accountId);
    try {
      if (!window.eco) throw new Error(t("settings.imageGeneration.desktopOnly"));
      await window.eco.openAIAccountsSetImageEnabled(accountId, enabled);
      setReload((value) => value + 1);
      onPoolChange();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setSavingId("");
    }
  }

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label={
            <ModelFieldLabel
              className="image-generation-route-label"
              label={t("settings.imageGeneration.loginRoute")}
              hint={t("settings.imageGeneration.loginRouteHelp")}
            />
          }
          description={t(
            web ? "settings.imageGeneration.webRequirements" : "settings.imageGeneration.codexRequirements",
          )}
          control={(props) => (
            <SettingsSelect
              {...props}
              variant="inline"
              value={profile.provider}
              disabled={busy || Boolean(savingId)}
              onChange={(event) => onRouteChange(event.target.value as ImageGenerationLoginRoute)}
            >
              <option value="chatgpt_web">Web</option>
              <option value="codex">Codex</option>
            </SettingsSelect>
          )}
        />
        <SettingsRow
          label={t("settings.imageGeneration.chatModel")}
          description={
            <>
              {t(
                !web && profile.chatModel === "gpt-5.5"
                  ? "settings.imageGeneration.codexChatModelUnavailable"
                  : web ? "settings.imageGeneration.webChatModelHelp" : "settings.imageGeneration.chatModelHelp",
              )}
              {modelsError ? (
                <span className="settings-form-error" role="alert">
                  {web ? modelsError : t("codexModels.refreshFailed", { message: modelsError })}
                </span>
              ) : !modelsLoading && !chatModels.length ? (
                <span>{t(web ? "settings.imageGeneration.webModelsEmpty" : "codexModels.empty")}</span>
              ) : null}
            </>
          }
          control={(props) => (
            <div className="image-generation-chat-model-controls">
              <SettingsSelect
                {...props}
                variant="inline"
                value={profile.chatModel}
                disabled={busy || Boolean(savingId) || modelsLoading || !chatModels.length}
                aria-busy={modelsLoading}
                onChange={(event) => onChatModelChange(event.target.value)}
              >
                {chatModels.some((model) => model.modelId === profile.chatModel) ? null : (
                  <option value={profile.chatModel} disabled>
                    {modelsLoading || modelsError
                      ? profile.chatModel
                      : t("settings.imageGeneration.chatModelNotInCatalog", { model: profile.chatModel })}
                  </option>
                )}
                {chatModels.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.displayName}{web ? ` (${model.modelId})` : ""}
                  </option>
                ))}
              </SettingsSelect>
              {web ? (
                <SettingsButton
                  disabled={busy || Boolean(savingId) || loading || modelsLoading}
                  onClick={() => {
                    refreshRequested.current = true;
                    setModelsReload((value) => value + 1);
                  }}
                >
                  {t("settings.imageGeneration.refreshWebModels")}
                </SettingsButton>
              ) : null}
            </div>
          )}
        />
        {web ? null : (
          <SettingsRow
            label={t("settings.imageGeneration.imageModel")}
            description={t("settings.imageGeneration.imageModelHelp")}
            stackControlOnNarrow
            control={(props) => (
              <div
                {...props}
                className="image-generation-model-select"
                role="group"
              >
                <img
                  src={CODEX_IMAGE_MODEL_ICONS[profile.model as keyof typeof CODEX_IMAGE_MODEL_ICONS]}
                  alt=""
                  aria-hidden="true"
                />
                <ComposerFieldSelect
                  value={profile.model}
                  onChange={onImageModelChange}
                  disabled={busy || Boolean(savingId)}
                  title={t("settings.imageGeneration.imageModel")}
                  renderOptionIcon={(option) => (
                    <img
                      src={CODEX_IMAGE_MODEL_ICONS[option.value as keyof typeof CODEX_IMAGE_MODEL_ICONS]}
                      alt=""
                    />
                  )}
                >
                  {IMAGE_GENERATION_CODEX_IMAGE_MODELS.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </ComposerFieldSelect>
              </div>
            )}
          />
        )}
        <SettingsRow
          label={t("settings.imageGeneration.supportsImageToImage")}
          control={(props) => (
            <Switch
              {...props}
              checked={profile.supportsImageToImage}
              disabled={busy}
              onCheckedChange={onImageEditingChange}
            />
          )}
        />
      </SettingsGroup>
      <SettingsSection
        title={t("settings.imageGeneration.loginPool")}
        description={t("settings.imageGeneration.loginPoolHint")}
        actions={
          onManageAccounts ? (
            <SettingsButton disabled={busy || Boolean(savingId)} onClick={onManageAccounts}>
              {t("settings.imageGeneration.manageAccounts")}
            </SettingsButton>
          ) : undefined
        }
      >
        {loading ? (
          <p className="settings-empty-hint" role="status">
            {t("common.loading")}
          </p>
        ) : loadError ? (
          <div role="alert">
            <p className="browser-settings-error">{loadError}</p>
            <SettingsButton onClick={() => setReload((value) => value + 1)}>
              {t("common.retry")}
            </SettingsButton>
          </div>
        ) : accounts.length === 0 ? (
          <p className="settings-empty-hint">{t("settings.imageGeneration.loginPoolEmpty")}</p>
        ) : (
          <>
            {!accounts.some((account) => account.imageGenerationEnabled) ? (
              <p className="settings-empty-hint" role="status">
                {t("settings.imageGeneration.loginPoolUnselected")}
              </p>
            ) : null}
            <SettingsResourceList>
              {accounts.map((account) => {
                const plan = account.quota?.planType;
                const credentialsUsable = canUseOpenAIAccountCredentials(account);
                const status =
                  account.authState === "refreshing"
                    ? "refreshingCredentials"
                    : account.authState === "refreshable"
                      ? "refreshableCredentials"
                      : credentialsUsable
                        ? "loggedIn"
                        : "needsLogin";
                return (
                  <SettingsResourceRow
                    key={account.id}
                    name={account.name}
                    description={account.email ?? account.quota?.email}
                    metadata={
                      <>
                        <span>
                          {t(`settings.openaiAccounts.${status}`)}
                          {plan ? ` · ${plan}` : ""}
                        </span>
                        {!web && plan && !["plus", "team", "pro"].includes(plan.toLowerCase()) ? (
                          <span>{t("settings.imageGeneration.codexRequirements")}</span>
                        ) : null}
                        {web &&
                        account.imageQuota?.status === "available" &&
                        account.imageQuota.remaining !== undefined ? (
                          <span>
                            {t("settings.imageGeneration.webQuota", { count: account.imageQuota.remaining })}
                          </span>
                        ) : null}
                        {web && account.imageQuota?.status === "error" ? (
                          <span>{account.imageQuota.error}</span>
                        ) : null}
                      </>
                    }
                    actions={
                      <Switch
                        checked={account.imageGenerationEnabled ?? false}
                        disabled={busy || loading || Boolean(savingId)}
                        aria-label={t("settings.imageGeneration.useAccount", { name: account.name })}
                        onCheckedChange={(checked) => void toggleAccount(account.id, checked)}
                      />
                    }
                  />
                );
              })}
            </SettingsResourceList>
          </>
        )}
      </SettingsSection>
    </>
  );
}
