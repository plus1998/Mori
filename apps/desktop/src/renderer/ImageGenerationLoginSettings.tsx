import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageGenerationLoginRoute, ImageGenerationProfileSnapshot } from "../shared/image-generation";
import { canUseOpenAIAccountCredentials, type OpenAIAccount } from "../shared/openai-account";
import { ModelFieldLabel } from "./ModelFieldLabel";
import { SettingsButton, SettingsSelect } from "./components/SettingsControls";
import { SettingsSection } from "./components/SettingsPage";
import { SettingsResourceList, SettingsResourceRow } from "./components/SettingsResourceList";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import { Switch } from "./components/Switch";

interface Props {
  profile: ImageGenerationProfileSnapshot;
  busy: boolean;
  onRouteChange: (route: ImageGenerationLoginRoute) => void;
  onImageEditingChange: (checked: boolean) => void;
  onPoolChange: () => void;
  onManageAccounts?: () => void;
  onError: (message: string) => void;
}

export function ImageGenerationLoginSettings({
  profile,
  busy,
  onRouteChange,
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
  const saving = useRef(false);
  const web = profile.provider === "chatgpt_web";

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
          label={t("settings.imageGeneration.model")}
          control={() => <span>{profile.model}</span>}
        />
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
