import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import type { ProxyBridgeSettingsSnapshot, UpstreamAgentCore } from "../shared/ipc";
import { UPSTREAM_AGENT_CORES } from "../shared/ipc";
import { AGENT_CORE_META, GatewayArchitectureDiagram } from "./GatewayArchitectureDiagram";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface ProxySettingsPanelProps {
  settings: ProxyBridgeSettingsSnapshot;
  busy?: boolean;
  onSave: (settings: ProxyBridgeSettingsSnapshot) => void;
  centerServerSyncVisible?: boolean;
  /** Landing tab; defaults to the architecture diagram. */
  initialTab?: GatewayTab;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

const GATEWAY_TABS = ["architecture", "proxy", "headers"] as const;

type GatewayTab = (typeof GATEWAY_TABS)[number];

type CoreUserAgentDrafts = Record<UpstreamAgentCore, string>;

function coreUserAgentDraftsFrom(
  overrides: Partial<Record<UpstreamAgentCore, string>> | undefined,
): CoreUserAgentDrafts {
  const drafts = {} as CoreUserAgentDrafts;
  for (const core of UPSTREAM_AGENT_CORES) {
    drafts[core] = overrides?.[core] ?? "";
  }
  return drafts;
}

export function ProxySettingsPanel({
  settings,
  busy,
  onSave,
  centerServerSyncVisible = false,
  initialTab = "architecture",
  onSyncDomain,
}: ProxySettingsPanelProps) {
  const { t } = useTranslation();
  const enabledId = useId();
  const [tab, setTab] = useState<GatewayTab>(initialTab);
  // enabled 缺省视为开启（兼容旧数据）
  const [enabledDraft, setEnabledDraft] = useState(settings.enabled !== false);
  const [proxyDraft, setProxyDraft] = useState(settings.upstreamProxyUrl ?? "");
  const [userAgentDraft, setUserAgentDraft] = useState(settings.upstreamUserAgent ?? "");
  const [coreUserAgentDrafts, setCoreUserAgentDrafts] = useState<CoreUserAgentDrafts>(() =>
    coreUserAgentDraftsFrom(settings.upstreamUserAgents),
  );
  const storedCoreUserAgents = settings.upstreamUserAgents;

  useEffect(() => {
    setEnabledDraft(settings.enabled !== false);
  }, [settings.enabled]);

  useEffect(() => {
    setProxyDraft(settings.upstreamProxyUrl ?? "");
  }, [settings.upstreamProxyUrl]);

  useEffect(() => {
    setUserAgentDraft(settings.upstreamUserAgent ?? "");
  }, [settings.upstreamUserAgent]);

  useEffect(() => {
    setCoreUserAgentDrafts(coreUserAgentDraftsFrom(storedCoreUserAgents));
  }, [storedCoreUserAgents]);

  const currentEnabled = settings.enabled !== false;
  // 每个 tab 只统计自己的字段，避免在一个 tab 里被另一个 tab 的草稿卡住。
  const proxyDirty =
    enabledDraft !== currentEnabled || proxyDraft.trim() !== (settings.upstreamProxyUrl ?? "");
  const userAgentDirty = userAgentDraft.trim() !== (settings.upstreamUserAgent ?? "");
  const coreUserAgentDirty = UPSTREAM_AGENT_CORES.some(
    (core) => coreUserAgentDrafts[core].trim() !== (settings.upstreamUserAgents?.[core] ?? ""),
  );

  function commitProxy() {
    if (enabledDraft) {
      // 显式携带 URL（可为空串）：清空输入 = 清除已保存的代理。
      onSave({ enabled: true, upstreamProxyUrl: proxyDraft.trim() });
    } else {
      // 关闭开关时保留已保存的 URL，方便重新开启。
      onSave({ enabled: false });
    }
  }

  // 逐个 Agent Core 保存；清空某个 core 即回退到该项目 SDK 自己的 User-Agent。
  function commitCoreUserAgents() {
    const next: Partial<Record<UpstreamAgentCore, string>> = {};
    for (const core of UPSTREAM_AGENT_CORES) {
      next[core] = coreUserAgentDrafts[core].trim();
    }
    onSave({
      upstreamUserAgents: next,
      // 兼底字段与三行一起提交，避免保存一个 tab 时漏掉另一个字段。
      upstreamUserAgent: userAgentDraft.trim(),
    });
  }

  function submitUserAgentOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") {
      return;
    }
    // User-Agent 不能包含换行（主进程会拒绝），回车直接提交保存。
    event.preventDefault();
    if (busy || !(coreUserAgentDirty || userAgentDirty)) {
      return;
    }
    void commitCoreUserAgents();
  }

  const syncControl = onSyncDomain ? (
    <SettingsSyncControl
      domain="proxyBridge"
      visible={centerServerSyncVisible}
      disabled={busy === true}
      onSync={onSyncDomain}
    />
  ) : null;

  return (
    <>
      <header className="settings-page-header settings-page-header-with-action">
        <h1>{t("settings.gateway")}</h1>
        {syncControl}
      </header>

      <div className="models-settings-tabs" role="tablist" aria-label={t("settings.gateway")}>
        {GATEWAY_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`gateway-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`gateway-tabpanel-${id}`}
            className={tab === id ? "models-settings-tab active" : "models-settings-tab"}
            onClick={() => setTab(id)}
          >
            {t(`settings.gateway.tab.${id}`)}
          </button>
        ))}
      </div>

      {tab === "architecture" && (
        <section
          className="settings-section"
          role="tabpanel"
          id="gateway-tabpanel-architecture"
          aria-labelledby="gateway-tab-architecture"
        >
          <p className="gateway-tab-lead">{t("settings.gateway.arch.subtitle")}</p>
          <GatewayArchitectureDiagram />
        </section>
      )}

      {tab === "proxy" && (
        <section
          className="settings-section proxy-settings-section gateway-tab-panel"
          role="tabpanel"
          id="gateway-tabpanel-proxy"
          aria-labelledby="gateway-tab-proxy"
        >
          <ul className="settings-rows">
            <li>
              <div className="notification-settings-row">
                <span className="settings-row-main" id={enabledId}>
                  <strong>{t("settings.proxy.enabled")}</strong>
                </span>
                <label
                  className="composer-switch notification-settings-switch"
                  title={t(enabledDraft ? "composer.enabledNamed" : "composer.disabledNamed", {
                    name: t("settings.proxy.enabled"),
                  })}
                >
                  <input
                    type="checkbox"
                    checked={enabledDraft}
                    disabled={busy}
                    aria-labelledby={enabledId}
                    onChange={(event) => setEnabledDraft(event.target.checked)}
                  />
                  <span className="composer-switch-track" aria-hidden />
                </label>
              </div>
            </li>
          </ul>

          <label className="mcp-field">
            <span className="mcp-field-label">{t("settings.proxy.url")}</span>
            <input
              className="mcp-field-input"
              value={proxyDraft}
              placeholder={t("settings.proxy.urlPlaceholder")}
              disabled={busy || !enabledDraft}
              onChange={(event) => setProxyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>

          <div className="git-settings-section-actions">
            <button
              type="button"
              className="mcp-save-button"
              disabled={busy || !proxyDirty}
              onClick={() => void commitProxy()}
            >
              {t("common.save")}
            </button>
          </div>
        </section>
      )}

      {tab === "headers" && (
        <section
          className="settings-section gateway-tab-panel"
          role="tabpanel"
          id="gateway-tabpanel-headers"
          aria-labelledby="gateway-tab-headers"
        >
          {UPSTREAM_AGENT_CORES.map((core) => {
            const meta = AGENT_CORE_META[core];
            return (
              <label className="mcp-field" key={core}>
                <span className="mcp-field-label gateway-core-ua-label">
                  <img className="gateway-core-ua-icon" src={meta.icon} alt="" aria-hidden="true" />
                  {meta.name}
                </span>
                <textarea
                  className="mcp-field-input mcp-field-textarea gateway-ua-input"
                  value={coreUserAgentDrafts[core]}
                  rows={2}
                  spellCheck={false}
                  placeholder={t("settings.ua.placeholder")}
                  disabled={busy}
                  aria-label={`${meta.name} User-Agent`}
                  onChange={(event) =>
                    setCoreUserAgentDrafts((current) => ({
                      ...current,
                      [core]: event.target.value,
                    }))
                  }
                  onKeyDown={submitUserAgentOnEnter}
                />
              </label>
            );
          })}

          <label className="mcp-field" key="fallback">
            <span className="mcp-field-label">{t("settings.gateway.headers.other")}</span>
            <textarea
              className="mcp-field-input mcp-field-textarea gateway-ua-input"
              value={userAgentDraft}
              rows={2}
              spellCheck={false}
              placeholder={t("settings.ua.placeholder")}
              disabled={busy}
              onChange={(event) => setUserAgentDraft(event.target.value)}
              onKeyDown={submitUserAgentOnEnter}
            />
          </label>

          <div className="git-settings-section-actions">
            <button
              type="button"
              className="mcp-save-button"
              disabled={busy || !(coreUserAgentDirty || userAgentDirty)}
              onClick={() => void commitCoreUserAgents()}
            >
              {t("common.save")}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
