import { useTranslation } from "react-i18next";
import type { ProviderEndpoint } from "../shared/ipc";
import { EndpointCompatSelect } from "./EndpointCompatSelect";

const protocols = [
  { apiCompat: "anthropic", requestPath: "" },
  { apiCompat: "openai_responses", requestPath: "" },
  { apiCompat: "openai_chat_completions", requestPath: "" },
  { apiCompat: "system_one", requestPath: "" },
] as const;

export function ProviderEndpointEditor({
  endpoints,
  baseUrl,
  disabled,
  onChange,
}: {
  endpoints: readonly ProviderEndpoint[];
  baseUrl: string;
  disabled: boolean;
  onChange: (endpoints: ProviderEndpoint[]) => void;
}) {
  const { t } = useTranslation();
  const update = (id: string, patch: Partial<ProviderEndpoint>) =>
    onChange(endpoints.map((endpoint) => (endpoint.id === id ? { ...endpoint, ...patch } : endpoint)));
  return (
    <div className="provider-form-section">
      <h4 className="provider-form-section-title">{t("candidateModels.additionalEndpoints")}</h4>
      <p className="mcp-field-hint">{t("candidateModels.additionalEndpointsHint")}</p>
      {endpoints.map((endpoint) => (
        <section className="provider-form-section" key={endpoint.id}>
          <label className="mcp-field">
            <span className="mcp-field-label">{t("settings.models.provider.name")}</span>
            <input
              className="mcp-field-input"
              value={endpoint.name}
              disabled={disabled}
              onChange={(event) => update(endpoint.id, { name: event.target.value })}
            />
          </label>
          <div className="mcp-field">
            <span className="mcp-field-label">{t("candidateModels.protocol")}</span>
            <EndpointCompatSelect
              options={protocols}
              activeApiCompat={endpoint.apiCompat}
              disabled={disabled}
              onChange={(apiCompat) => update(endpoint.id, { apiCompat })}
            />
          </div>
          <label className="mcp-field">
            <span className="mcp-field-label">{t("candidateModels.requestPath")}</span>
            <input
              className="mcp-field-input"
              value={endpoint.requestPath}
              disabled={disabled}
              placeholder="/anthropic"
              onChange={(event) => update(endpoint.id, { requestPath: event.target.value })}
            />
          </label>
          <label className="mcp-field">
            <span className="mcp-field-label">{t("candidateModels.apiVersion")}</span>
            <input
              className="mcp-field-input"
              value={endpoint.version}
              disabled={disabled}
              placeholder="v1"
              onChange={(event) => update(endpoint.id, { version: event.target.value })}
            />
          </label>
          <label className="mcp-field">
            <span className="mcp-field-label">{t("candidateModels.endpointAddressOverride")}</span>
            <input
              className="mcp-field-input"
              value={endpoint.baseUrl ?? ""}
              disabled={disabled}
              placeholder={baseUrl}
              onChange={(event) => update(endpoint.id, { baseUrl: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="mcp-uninstall-button"
            disabled={disabled}
            onClick={() => onChange(endpoints.filter((entry) => entry.id !== endpoint.id))}
          >
            {t("common.delete")}
          </button>
        </section>
      ))}
      <button
        type="button"
        className="mcp-save-button"
        disabled={disabled}
        onClick={() =>
          onChange([
            ...endpoints,
            {
              id: `endpoint-${crypto.randomUUID()}`,
              name: t("candidateModels.newEndpoint"),
              apiCompat: "openai_responses",
              requestPath: "",
              version: "v1",
            },
          ])
        }
      >
        {t("candidateModels.addEndpoint")}
      </button>
    </div>
  );
}
