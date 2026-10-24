import { ChevronDown, LinkIcon, LoaderCircle, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  WEB_SEARCH_APPROVAL_MODES,
  type WebSearchApprovalMode,
} from "../shared/integrated-web-search";
import type {
  IntegratedWebSearchProvider,
  IntegratedWebSearchSettingsSaveInput,
  IntegratedWebSearchSettingsSnapshot,
  IntegratedWebSearchTestResult,
} from "../shared/ipc";
import { ProviderPresetIcon } from "./ProviderPresetTabs";

interface IntegratedWebSearchSettingsSectionProps {
  settings: IntegratedWebSearchSettingsSnapshot;
  disabled?: boolean | undefined;
  onSave: (input: IntegratedWebSearchSettingsSaveInput) => void;
}

const PROVIDERS: readonly {
  id: IntegratedWebSearchProvider;
  apiKeyUrl: string;
  iconSrc: string;
}[] = [
  {
    id: "tavily",
    apiKeyUrl: "https://app.tavily.com/home",
    iconSrc: "./provider-icons/tavily.ico",
  },
  {
    id: "doubao",
    apiKeyUrl: "https://console.volcengine.com/search-infinity",
    iconSrc: "./provider-icons/doubao.png",
  },
  {
    id: "deepseek",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    iconSrc: "./provider-icons/deepseek.ico",
  },
  {
    id: "brave",
    apiKeyUrl: "https://api-dashboard.search.brave.com/",
    iconSrc: "./provider-icons/brave.svg",
  },
];

export function IntegratedWebSearchSettingsSection({
  settings,
  disabled,
  onSave,
}: IntegratedWebSearchSettingsSectionProps) {
  const { t } = useTranslation();
  const enableId = useId();
  const approvalId = useId();
  const queryId = useId();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [provider, setProvider] = useState(settings.provider);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [testQuery, setTestQuery] = useState("OpenAI");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<IntegratedWebSearchTestResult>();
  const [testError, setTestError] = useState<string>();
  const testRequest = useRef(0);

  useEffect(() => {
    setTestResult(undefined);
    setTestError(undefined);
    setTesting(false);
    return () => { testRequest.current += 1; };
  }, [provider, settings.provider, settings.hasApiKey, apiKeyDraft, testQuery, enabled]);

  useEffect(() => {
    setEnabled(settings.enabled);
  }, [settings.enabled]);

  useEffect(() => {
    setProvider(settings.provider);
  }, [settings.provider]);

  const selectedProvider = PROVIDERS.find((entry) => entry.id === provider) ?? PROVIDERS[0]!;
  const fieldsDisabled = disabled || !enabled || testing;
  const canTest = !fieldsDisabled && provider === settings.provider && settings.hasApiKey &&
    !apiKeyDraft.trim() && Boolean(testQuery.trim());

  async function testSearch() {
    if (!canTest || !window.eco) return;
    const request = ++testRequest.current;
    setTesting(true);
    setTestResult(undefined);
    setTestError(undefined);
    try {
      const result = await window.eco.testIntegratedWebSearch({ provider, query: testQuery.trim() });
      if (request === testRequest.current) setTestResult(result);
    } catch (error) {
      if (request === testRequest.current) {
        setTestError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === testRequest.current) setTesting(false);
    }
  }

  function commitEnabled(nextEnabled: boolean) {
    setEnabled(nextEnabled);
    if (nextEnabled === settings.enabled) {
      return;
    }
    onSave({ enabled: nextEnabled });
  }

  function commitProvider(nextProvider: IntegratedWebSearchProvider) {
    setProvider(nextProvider);
    setApiKeyDraft("");
    if (nextProvider === settings.provider) {
      return;
    }
    onSave({ provider: nextProvider });
  }

  function commitApprovalMode(nextMode: WebSearchApprovalMode) {
    if (nextMode === settings.approvalMode) {
      return;
    }
    onSave({ approvalMode: nextMode });
  }

  function commitApiKey() {
    const trimmed = apiKeyDraft.trim();
    if (!trimmed) {
      return;
    }
    onSave({ apiKey: trimmed });
    setApiKeyDraft("");
  }

  function clearApiKey() {
    onSave({ apiKey: "" });
    setApiKeyDraft("");
  }

  return (
    <section className="provider-form-section models-integrated-web-search-section">
      <div className="mcp-field models-toggle-field provider-enable-row">
        <span className="integrated-web-search-enable-copy" id={enableId}>
          <span className="mcp-field-label">{t("settings.integratedWebSearch.enabled")}</span>
        </span>
        <label
          className="mcp-toggle mcp-toggle-sm"
          title={enabled ? t("common.enabled") : t("common.disabled")}
        >
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled || testing}
            aria-labelledby={enableId}
            onChange={(event) => commitEnabled(event.target.checked)}
          />
          <span className="mcp-toggle-track" aria-hidden />
        </label>
      </div>

      <div className="mcp-field models-provider-preset-field">
        <span className="mcp-field-label">{t("settings.integratedWebSearch.provider")}</span>
        <div
          className="provider-preset-tabs"
          role="radiogroup"
          aria-label={t("settings.integratedWebSearch.provider")}
        >
          {PROVIDERS.map((entry) => {
            const selected = provider === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                className={`provider-preset-tab${selected ? " is-active" : ""}`}
                aria-checked={selected}
                disabled={fieldsDisabled}
                onClick={() => commitProvider(entry.id)}
              >
                <ProviderPresetIcon src={entry.iconSrc} />
                <span className="provider-preset-tab-label">
                  {t(`settings.integratedWebSearch.providers.${entry.id}`)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <label className="mcp-field">
        <span className="models-provider-label-row">
          <span className="mcp-field-label">{t(`settings.integratedWebSearch.apiKey.${provider}`)}</span>
          <span className="integrated-web-search-api-key-actions">
            <a
              className="models-provider-inline-link"
              href={selectedProvider.apiKeyUrl}
              target="_blank"
              rel="noreferrer"
            >
              <LinkIcon size={12} />
              {t("settings.integratedWebSearch.createKey")}
            </a>
            {settings.hasApiKey ? (
              <button
                type="button"
                className="models-provider-inline-link integrated-web-search-clear-key"
                disabled={fieldsDisabled}
                onClick={() => clearApiKey()}
              >
                {t("settings.integratedWebSearch.clearApiKey")}
              </button>
            ) : null}
          </span>
        </span>
        <input
          className="mcp-field-input"
          type="password"
          value={apiKeyDraft}
          placeholder={
            settings.hasApiKey
              ? t("settings.integratedWebSearch.apiKeyConfigured")
              : t(`settings.integratedWebSearch.apiKeyPlaceholder.${provider}`)
          }
          disabled={fieldsDisabled}
          onChange={(event) => setApiKeyDraft(event.target.value)}
          onBlur={() => commitApiKey()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
      </label>

      <div className="mcp-field integrated-web-search-test">
        <label className="mcp-field-label" htmlFor={queryId}>
          {t("settings.integratedWebSearch.testQuery")}
        </label>
        <div className="integrated-web-search-test-controls">
          <input
            id={queryId}
            className="mcp-field-input"
            value={testQuery}
            maxLength={128}
            disabled={fieldsDisabled}
            onChange={(event) => setTestQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void testSearch();
              }
            }}
          />
          <button
            type="button"
            className="mcp-save-button integrated-web-search-test-button"
            disabled={!canTest}
            onClick={() => void testSearch()}
          >
            {testing ? <LoaderCircle size={14} className="spinning" aria-hidden /> : <Search size={14} aria-hidden />}
            {t(testing ? "settings.integratedWebSearch.testing" : "settings.integratedWebSearch.test")}
          </button>
        </div>
        <small className="mcp-field-hint">{t("settings.integratedWebSearch.testHint")}</small>
        <div role="status" aria-live="polite" aria-busy={testing}>
          {testError ? (
            <p className="integrated-web-search-test-error">
              {t("settings.integratedWebSearch.testFailed", { error: testError })}
            </p>
          ) : null}
          {testResult ? (
            <>
              <p className={testResult.results.length ? "integrated-web-search-test-success" : "mcp-field-hint"}>
                {t(testResult.results.length ? "settings.integratedWebSearch.testPassed" : "settings.integratedWebSearch.testEmpty", {
                  count: testResult.results.length,
                  duration: (testResult.elapsedMs / 1000).toFixed(2),
                })}
              </p>
              <ul className="integrated-web-search-test-results">
                {testResult.results.map((result, index) => (
                  <li key={`${index}-${result.url}`}>
                    {/^https?:\/\//i.test(result.url) ? (
                      <a href={result.url} target="_blank" rel="noreferrer">{result.title || result.url}</a>
                    ) : <strong>{result.title || result.url}</strong>}
                    {result.url ? <small>{result.url}</small> : null}
                    {result.description ? <p>{result.description}</p> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {enabled ? (
        <div className="mcp-field models-toggle-field provider-enable-row">
          <span className="integrated-web-search-enable-copy" id={approvalId}>
            <span className="mcp-field-label">{t("settings.integratedWebSearch.approvalMode")}</span>
            <small>{t("settings.integratedWebSearch.approvalModeHint")}</small>
          </span>
          <label className="browser-settings-select">
            <span className="sr-only">{t("settings.integratedWebSearch.approvalMode")}</span>
            <select
              value={settings.approvalMode}
              disabled={disabled || testing}
              aria-labelledby={approvalId}
              onChange={(event) => commitApprovalMode(event.target.value as WebSearchApprovalMode)}
            >
              {(WEB_SEARCH_APPROVAL_MODES as readonly WebSearchApprovalMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {t(`settings.integratedWebSearch.approvalMode.${mode}`)}
                </option>
              ))}
            </select>
            <ChevronDown size={14} strokeWidth={2} aria-hidden className="browser-settings-select-chevron" />
          </label>
        </div>
      ) : null}
    </section>
  );
}
