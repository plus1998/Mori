import { useTranslation } from "react-i18next";
import type { ConversationMessage } from "@eco/shared";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  History,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minus,
  Monitor,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MORI_ASSISTANT_SETTINGS,
  type MoriAssistantSettings,
  type MoriAssistantSnapshot,
  moriPetSize,
} from "../shared/mori-assistant";
import {
  type MoriPetAnimation,
  type MoriPetAsset,
  type MoriPetHitMap,
  moriPetHitTest,
} from "../shared/mori-pet";
import { shortcutMatches, useKeyboardShortcuts } from "./keyboard-shortcuts";
import { LazyOpenAIAccountsPanel } from "./lazy-app-panels";
import { MarkdownContent } from "./MarkdownContent";
import { MoriIcon } from "./MoriIcon";
import { MoriScheduledCards } from "./MoriScheduledCards";
import { MoriPetSettings } from "./MoriPetSettings";
import { MoriPetSprite } from "./MoriPetSprite";
import { DEFAULT_MORI_PET } from "./mori-default-pet";
import "./mori-assistant.css";

function desktopApi() {
  if (!window.eco) throw new Error("桌面连接尚未就绪，请重新打开 Mori。");
  return window.eco;
}

/**
 * Composer sizing. The textarea never drops below two and a half lines and grows with the
 * draft up to the same ceiling as the main Composer (`.mori-composer textarea` in
 * mori-assistant.css mirrors both values).
 */
const MORI_COMPOSER_MIN_HEIGHT = 76;
const MORI_COMPOSER_MAX_HEIGHT = 200;

function useAssistant() {
  const [snapshot, setSnapshot] = useState<MoriAssistantSnapshot>();
  const [error, setError] = useState("");
  const loading = useRef(false);
  const requested = useRef(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    requested.current = true;
    if (loading.current) return;
    loading.current = true;
    try {
      while (requested.current && alive.current) {
        requested.current = false;
        const next = await desktopApi().moriAssistantSnapshot();
        if (alive.current) {
          setSnapshot(next);
          setError("");
        }
      }
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = desktopApi().onMoriAssistantChanged(() => {
      void refresh();
    });
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return { snapshot, error, setError, refresh };
}

export function MoriAssistantSettingsPanel({
  onDone,
  onOpenComputerUse,
}: {
  onDone?: () => void;
  onOpenComputerUse?: () => void;
}) {
  const { t } = useTranslation();
  useKeyboardShortcuts();
  const { snapshot, error, setError, refresh } = useAssistant();
  const [settings, setSettings] = useState<MoriAssistantSettings>();
  const [tab, setTab] = useState<"conversation" | "desktop" | "wechat">("conversation");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const dirty = !!settings && !!snapshot && JSON.stringify(settings) !== JSON.stringify(snapshot.settings);
  const running = snapshot?.status === "running" || snapshot?.status === "waiting";
  const previousSettings = useRef<MoriAssistantSettings | undefined>(undefined);
  useEffect(() => {
    if (!snapshot) return;
    const previous = previousSettings.current;
    setSettings((current) =>
      !current || JSON.stringify(current) === JSON.stringify(previous) ? snapshot.settings : current,
    );
    previousSettings.current = snapshot.settings;
  }, [snapshot]);
  const patch = <K extends keyof MoriAssistantSettings>(key: K, value: MoriAssistantSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
    setError("");
  };
  const persist = async () => {
    if (!settings) throw new Error("助手设置尚未就绪。");
    const next = await desktopApi().moriAssistantSaveSettings(settings);
    setSettings(next.settings);
    setSaved(true);
    await refresh();
  };
  const action = async (callback: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await callback();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const manageAccounts = () => setAccountsOpen(true);
  if (accountsOpen)
    return (
      <section className="mori-settings mori-manage-accounts" aria-label={t("moriUi.moriAssistant.accounts")}>
        <button
          type="button"
          className="mori-text-button"
          onClick={() => {
            setAccountsOpen(false);
            void refresh();
          }}
        >
          <ArrowLeft size={14} />
          {t("moriUi.moriAssistant.backToSettings")}
        </button>
        <Suspense fallback={<p role="status">{t("moriUi.moriAssistant.loadingAccounts")}</p>}>
          <LazyOpenAIAccountsPanel onError={setError} />
        </Suspense>
        {error ? (
          <p className="mori-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  if (!settings || !snapshot) return <p role="status">{error || "正在读取助手设置…"}</p>;
  const custom = settings.modelSource === "custom";
  const selectedProvider = snapshot.customProviders.find((provider) => provider.id === settings.providerId);
  const missingAccount = settings.enabled && !custom && !settings.accountIds.length;
  const unavailableAccountIds = settings.accountIds.filter(
    (id) => !snapshot.accounts.some((account) => account.id === id),
  );
  const missingProvider = custom && !selectedProvider;
  const invalid =
    missingAccount ||
    (settings.enabled && !custom && unavailableAccountIds.length > 0) ||
    (settings.enabled && missingProvider) ||
    !settings.model.trim() ||
    !settings.name.trim();
  const modelChoices = custom ? (selectedProvider?.models ?? []) : snapshot.models;
  const locked = busy || running;
  const tabs = [
    { id: "conversation", label: "对话", icon: Sparkles },
    { id: "desktop", label: "桌面", icon: Monitor },
    { id: "wechat", label: "微信", icon: MessageCircle },
  ] as const;
  return (
    <section className="mori-settings" aria-label={t("moriUi.moriAssistant.settings")}>
      <div className="mori-settings-heading">
        <span className="mori-mark">
          <MoriIcon />
        </span>
        <div>
          <h2>Mori</h2>
          <p>{t("moriUi.moriAssistant.intro")}</p>
        </div>
        <span className={`mori-status-pill ${snapshot.settings.enabled ? "is-ready" : ""}`}>
          {snapshot.settings.enabled ? "已启用" : "未启用"}
        </span>
      </div>
      <label className="mori-toggle mori-enable">
        <span>
          <strong>{t("moriUi.moriAssistant.enable")}</strong>
          <small>{t("moriUi.moriAssistant.configureHint")}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={settings.enabled}
          aria-checked={settings.enabled}
          disabled={locked}
          onChange={(event) => patch("enabled", event.target.checked)}
        />
      </label>
      <nav className="mori-settings-tabs" aria-label={t("moriUi.moriAssistant.settingsCategories")}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            aria-pressed={tab === id}
            className={tab === id ? "is-selected" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>
      {running ? (
        <p className="mori-notice" role="status">
          {t("moriUi.moriAssistant.busySettings")}
        </p>
      ) : null}
      <fieldset disabled={locked}>
        {tab === "conversation" ? (
          <>
            <section className="mori-settings-section">
              <div className="mori-section-heading">
                <h3>{t("moriUi.moriAssistant.modelSource")}</h3>
              </div>
              <label>
                {t("moriUi.moriAssistant.usage")}
                <select
                  aria-label={t("moriUi.moriAssistant.assistantModelSource")}
                  value={settings.modelSource}
                  onChange={(event) => {
                    const source = event.target.value as MoriAssistantSettings["modelSource"];
                    const provider = selectedProvider ?? snapshot.customProviders[0];
                    setSettings((current) =>
                      current
                        ? {
                            ...current,
                            modelSource: source,
                            providerId: provider?.id ?? "",
                            model:
                              source === "custom"
                                ? (provider?.models[0]?.id ?? "")
                                : DEFAULT_MORI_ASSISTANT_SETTINGS.model,
                          }
                        : current,
                    );
                    setSaved(false);
                    setError("");
                  }}
                >
                  <option value="chatgpt">{t("moriUi.moriAssistant.chatgptAccount")}</option>
                  <option value="custom">{t("moriUi.moriAssistant.customModel")}</option>
                </select>
              </label>
              {custom ? (
                <>
                  <label>
                    {t("moriUi.moriAssistant.provider")}
                    <select
                      aria-label={t("moriUi.moriAssistant.assistantProvider")}
                      value={settings.providerId}
                      aria-invalid={missingProvider}
                      onChange={(event) => {
                        const provider = snapshot.customProviders.find(
                          (provider) => provider.id === event.target.value,
                        );
                        setSettings((current) =>
                          current
                            ? {
                                ...current,
                                providerId: event.target.value,
                                model: provider?.models[0]?.id ?? "",
                              }
                            : current,
                        );
                        setSaved(false);
                        setError("");
                      }}
                    >
                      <option value="">{t("moriUi.moriAssistant.selectProvider")}</option>
                      {settings.providerId && !selectedProvider ? (
                        <option value={settings.providerId}>{t("moriUi.moriAssistant.providerUnavailable")}</option>
                      ) : null}
                      {snapshot.customProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mori-muted">{t("moriUi.moriAssistant.enabledProvidersHint")}</p>
                  {missingProvider ? (
                    <p className="mori-field-error">
                      {t("moriUi.moriAssistant.configureProviderHint")}
                    </p>
                  ) : null}
                </>
              ) : null}
            </section>
            {!custom ? (
              <section className="mori-settings-section">
                <div className="mori-section-heading">
                  <h3>{t("moriUi.moriAssistant.selectedAccounts")}</h3>
                  <small>{t("moriUi.moriAssistant.independentAccount")}</small>
                </div>
                {snapshot.accounts.length === 0 ? (
                  <div className="mori-account-empty">
                    <p>{t("moriUi.moriAssistant.noAccounts")}</p>
                    <button type="button" onClick={manageAccounts}>
                      {t("moriUi.moriAssistant.addAccount")}
                      <ChevronRight size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="mori-account-list">
                    {snapshot.accounts.map((account) => {
                      const index = settings.accountIds.indexOf(account.id);
                      const quota = account.quota?.rateLimit.primaryWindow;
                      return (
                        <label key={account.id} className={`mori-account ${index >= 0 ? "is-selected" : ""}`}>
                          <input
                            type="checkbox"
                            checked={index >= 0}
                            onChange={(event) =>
                              patch(
                                "accountIds",
                                event.target.checked
                                  ? [...settings.accountIds, account.id]
                                  : settings.accountIds.filter((id) => id !== account.id),
                              )
                            }
                          />
                          <span>
                            <strong>{account.name}</strong>
                            <small>{account.email ?? (account.isLoggedIn ? "已登录" : "需要登录")}</small>
                          </span>
                          <span className="mori-account-meta">
                            {quota
                              ? `已用 ${Math.round(quota.usedPercent)}%`
                              : account.isLoggedIn
                                ? "已登录"
                                : "需要登录"}
                            {index >= 0 ? <small>{index === 0 ? "首选账号" : `备用 ${index}`}</small> : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {unavailableAccountIds.map((id) => (
                  <label key={id} className="mori-account is-selected">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => patch("accountIds", settings.accountIds.filter((item) => item !== id))}
                    />
                    <span>
                      <strong>{t("moriUi.moriAssistant.missingAccount")}</strong>
                      <small>{id}</small>
                    </span>
                    <span className="mori-account-meta">{t("moriUi.moriAssistant.uncheckToRemove")}</span>
                  </label>
                ))}
                {missingAccount ? <p className="mori-field-error">{t("moriUi.moriAssistant.selectAccountHint")}</p> : null}
                {unavailableAccountIds.length ? <p className="mori-field-error">{t("moriUi.moriAssistant.removeMissingHint")}</p> : null}
                {snapshot.accounts.length > 0 ? (
                  <button type="button" className="mori-text-button" onClick={manageAccounts}>
                    {t("moriUi.moriAssistant.manageAccounts")}
                    <ExternalLink size={12} />
                  </button>
                ) : null}
                <label className="mori-check">
                  <input
                    type="checkbox"
                    checked={settings.autoSwitchAccounts}
                    onChange={(event) => patch("autoSwitchAccounts", event.target.checked)}
                  />
                  {t("moriUi.moriAssistant.accountRotation")}
                </label>
              </section>
            ) : null}
            <section className="mori-settings-section">
              <div className="mori-section-heading">
                <h3>{t("moriUi.moriAssistant.preferences")}</h3>
              </div>
              <div className="mori-settings-grid">
                <label>
                  {t("moriUi.moriAssistant.model")}
                  <input
                    list="mori-models"
                    value={settings.model}
                    aria-invalid={!settings.model.trim()}
                    onChange={(event) => patch("model", event.target.value)}
                  />
                  <datalist id="mori-models">
                    {modelChoices.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                    {!custom && !modelChoices.length ? (
                      <option value={DEFAULT_MORI_ASSISTANT_SETTINGS.model} />
                    ) : null}
                  </datalist>
                  <small>{custom ? "可选择或填写服务商支持的模型 ID" : "可选择或填写账号支持的模型"}</small>
                </label>
                <label>
                  {t("moriUi.moriAssistant.reasoning")}
                  <select
                    value={settings.reasoningEffort}
                    onChange={(event) =>
                      patch("reasoningEffort", event.target.value as MoriAssistantSettings["reasoningEffort"])
                    }
                  >
                    <option value="low">{t("moriUi.moriAssistant.reasoningLow")}</option>
                    <option value="medium">{t("moriUi.moriAssistant.reasoningMedium")}</option>
                    <option value="high">{t("moriUi.moriAssistant.reasoningHigh")}</option>
                  </select>
                </label>
              </div>
              <p className="mori-workspace-note">
                <FolderOpen size={14} />
                <span>{t("moriUi.moriAssistant.workspaceHint")}</span>
              </p>
              <details className="mori-personality">
                <summary>
                  {t("moriUi.moriAssistant.nameAndInstructions")}
                  <ChevronDown size={14} />
                </summary>
                <div>
                  <label>
                    {t("moriUi.moriAssistant.name")}
                    <input
                      value={settings.name}
                      maxLength={60}
                      aria-invalid={!settings.name.trim()}
                      onChange={(event) => patch("name", event.target.value)}
                    />
                  </label>
                  <label>
                    {t("moriUi.moriAssistant.instructions")}
                    <textarea
                      rows={4}
                      value={settings.instructions}
                      onChange={(event) => patch("instructions", event.target.value)}
                    />
                  </label>
                </div>
              </details>
            </section>
          </>
        ) : null}
        {tab === "desktop" ? (
          <section className="mori-settings-section">
            <div className="mori-section-heading">
              <h3>{t("moriUi.moriAssistant.invoke")}</h3>
            </div>
            <div className="mori-computer-capability">
              <div>
                <Monitor size={16} />
                <strong>{t("moriUi.moriAssistant.computerUse")}</strong>
                <span className={`mori-status-pill ${snapshot.computerUse.available ? "is-ready" : ""}`}>
                  {snapshot.computerUse.available
                    ? "已接入"
                    : snapshot.computerUse.enabled
                      ? "不可用"
                      : "未开启"}
                </span>
              </div>
              <p>
                {snapshot.computerUse.available
                  ? `可让 Mori 查看和操作本机应用。${snapshot.computerUse.actionApprovalMode === "always_ask" ? "点击、输入等操作会先征求你的确认。" : "操作沿用电脑操作设置中的始终允许模式。"}`
                  : snapshot.computerUse.reason}
              </p>
              {onOpenComputerUse ? (
                <button type="button" onClick={onOpenComputerUse}>
                  {t("moriUi.moriAssistant.computerUseSettings")}
                  <ChevronRight size={13} />
                </button>
              ) : (
                <small>{t("moriUi.moriAssistant.computerUseHint")}</small>
              )}
            </div>
            <label className="mori-toggle">
              <span>
                <strong>{t("moriUi.moriAssistant.desktopBall")}</strong>
                <small>{t("moriUi.moriAssistant.desktopBallHint")}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.floatingEnabled}
                aria-checked={settings.floatingEnabled}
                onChange={(event) => patch("floatingEnabled", event.target.checked)}
              />
            </label>
            <MoriPetSettings
              value={settings.petKey}
              onChange={(value) => patch("petKey", value)}
              size={moriPetSize(settings)}
              onSizeChange={(size) =>
                patch("petSizes", { ...settings.petSizes, [settings.petKey || "builtin:mori"]: size })
              }
            />
            <label className="mori-toggle">
              <span>
                <strong>{t("moriUi.moriAssistant.keepRunning")}</strong>
                <small>{t("moriUi.moriAssistant.keepRunningHint")}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.backgroundEnabled}
                aria-checked={settings.backgroundEnabled}
                onChange={(event) => patch("backgroundEnabled", event.target.checked)}
              />
            </label>
            <p className="mori-settings-hint">{t("moriUi.moriAssistant.shortcutHint")}</p>
          </section>
        ) : null}
        {tab === "wechat" ? (
          <section className="mori-settings-section mori-wechat">
            <label className="mori-toggle">
              <span>
                <strong>{t("moriUi.moriAssistant.wechatInvoke")}</strong>
                <small>{t("moriUi.moriAssistant.wechatHint")}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.wechatEnabled}
                aria-checked={settings.wechatEnabled}
                onChange={(event) => patch("wechatEnabled", event.target.checked)}
              />
            </label>
            <div className="mori-wechat-connection">
              <span
                className={`mori-status-pill ${snapshot.wechat.status === "connected" ? "is-ready" : ""}`}
              >
                {
                  {
                    connected: "微信已连接",
                    waiting: "等待扫码",
                    disconnected: "尚未连接",
                    error: "连接异常",
                  }[snapshot.wechat.status]
                }
              </span>
              {snapshot.wechat.qrContent ? (
                <div className="mori-qr">
                  <QRCodeSVG value={snapshot.wechat.qrContent} size={172} />
                </div>
              ) : (
                <MessageCircle size={32} className="mori-muted" />
              )}
              <strong>
                {snapshot.wechat.status === "connected"
                  ? "可以从微信发消息了"
                  : snapshot.wechat.status === "waiting"
                    ? "用微信扫一扫，确认连接"
                    : "把 Mori 带到微信"}
              </strong>
              <p>
                {snapshot.wechat.status === "connected"
                  ? "保持桌面端运行、电脑唤醒并联网。"
                  : "启用后生成二维码，使用微信扫码连接。"}
              </p>
              <div className="mori-settings-actions">
                <button
                  type="button"
                  className="mori-primary"
                  disabled={!settings.enabled || !settings.wechatEnabled || invalid}
                  onClick={() =>
                    void action(async () => {
                      if (dirty) await persist();
                      await desktopApi().moriAssistantBindWechat();
                    })
                  }
                >
                  {snapshot.wechat.status === "connected"
                    ? "重新连接"
                    : snapshot.wechat.status === "waiting"
                      ? "刷新二维码"
                      : dirty
                        ? "保存并生成二维码"
                        : "生成登录二维码"}
                </button>
                {snapshot.wechat.status !== "disconnected" ? (
                  <button
                    type="button"
                    onClick={() => void action(() => desktopApi().moriAssistantDisconnectWechat())}
                  >
                    {t("moriUi.moriAssistant.disconnect")}
                  </button>
                ) : null}
              </div>
              {!settings.enabled || !settings.wechatEnabled ? (
                <small>{t("moriUi.moriAssistant.qrPrerequisite")}</small>
              ) : null}
            </div>
            {snapshot.wechat.error ? (
              <p role="alert" className="mori-error">
                {snapshot.wechat.error}
              </p>
            ) : null}
            {snapshot.wechat.feedbackError ? (
              <p role="status" className="mori-muted">
                {snapshot.wechat.feedbackError}
              </p>
            ) : null}
            <p className="mori-muted">
              {t("moriUi.moriAssistant.typingHint")}
            </p>
            <p className="mori-muted">{t("moriUi.moriAssistant.wechatFormats")}</p>
          </section>
        ) : null}
      </fieldset>
      <div className="mori-settings-savebar">
        {error ? (
          <p className="mori-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mori-settings-actions">
          <span role="status" className="mori-save-status">
            {busy ? (
              "正在处理…"
            ) : dirty ? (
              "有未保存的更改"
            ) : saved ? (
              <>
                <Check size={13} />
                {t("moriUi.moriAssistant.saved")}
              </>
            ) : (
              "设置已同步"
            )}
          </span>
          {dirty ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setSettings(snapshot.settings);
                setError("");
                setSaved(false);
              }}
            >
              {t("moriUi.moriAssistant.discard")}
            </button>
          ) : null}
          <button
            type="button"
            className="mori-primary"
            disabled={locked || invalid || !dirty}
            onClick={() => void action(persist)}
          >
            {busy ? <LoaderCircle size={14} className="spinning" /> : null}{t("moriUi.moriAssistant.saveSettings")}
          </button>
          {snapshot.settings.enabled && !dirty ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => (onDone ? onDone() : void action(() => desktopApi().moriAssistantShowMain()))}
            >
              {t("moriUi.moriAssistant.startChat")}
              <ChevronRight size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const taskStatus = {
  running: "正在执行",
  queued: "排队中",
  completed: "已完成",
  failed: "执行失败",
  awaiting_plan: "等待确认",
  blocked: "需要处理",
  idle: "空闲",
};

export function MoriAssistantPanel({
  floating = false,
  onClose,
  onSettings,
}: {
  floating?: boolean;
  onClose?: () => void;
  onSettings?: () => void;
}) {
  const { t } = useTranslation();
  useKeyboardShortcuts();
  const { snapshot, error, setError, refresh } = useAssistant();
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [older, setOlder] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string>();
  const [olderDone, setOlderDone] = useState(false);
  const editorFocused = useRef(false);
  const latestDraft = useRef("");
  const draftDirty = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftWrite = useRef<Promise<void>>(Promise.resolve());
  const end = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const remoteDraft = snapshot?.draft;
  const sessionId = snapshot?.currentThreadId;
  const previousSession = useRef<string | undefined>(undefined);
  const latestMessageBody = snapshot?.messages.at(-1)?.body;
  const pendingInput = snapshot?.pendingInput;
  const fitComposer = useCallback(() => {
    const field = editor.current;
    if (!field) return;
    // `height: auto` first so the field can shrink back when the draft gets shorter.
    field.style.height = "auto";
    field.style.height = `${Math.min(
      Math.max(field.scrollHeight, MORI_COMPOSER_MIN_HEIGHT),
      MORI_COMPOSER_MAX_HEIGHT,
    )}px`;
  }, []);
  useEffect(() => {
    if (remoteDraft !== undefined && !editorFocused.current && !draftDirty.current) {
      setDraft(remoteDraft);
      latestDraft.current = remoteDraft;
    }
  }, [remoteDraft]);
  useEffect(() => {
    if (previousSession.current === sessionId) return;
    previousSession.current = sessionId;
    setOlder([]);
    setOlderCursor(undefined);
    setOlderDone(false);
    followEnd.current = true;
    setAwayFromEnd(false);
    setAnswer("");
  }, [sessionId]);
  useEffect(() => {
    if (pendingInput?.id) setAnswer("");
  }, [pendingInput?.id]);
  useEffect(() => {
    if (latestMessageBody !== undefined && followEnd.current) end.current?.scrollIntoView({ block: "end" });
  }, [latestMessageBody]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft's content is what the textarea's height must follow, even though the effect only reads scrollHeight.
  useEffect(() => {
    if (settingsOpen) return;
    fitComposer();
  }, [draft, settingsOpen, fitComposer]);
  useEffect(() => {
    if (settingsOpen) return;
    // Re-measure on resize: line wrapping changes how many rows the draft needs.
    const fit = () => fitComposer();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [settingsOpen, fitComposer]);
  useEffect(() => {
    if (!historyOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !history.current?.contains(event.target) &&
        !historyTrigger.current?.contains(event.target)
      )
        setHistoryOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setHistoryOpen(false);
        historyTrigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [historyOpen]);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  useEffect(() => {
    const blur = () => {
      editorFocused.current = false;
    };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftDirty.current) void desktopApi().moriAssistantSetDraft(latestDraft.current);
    };
  }, []);
  const perform = async (callback: () => Promise<unknown>) => {
    setError("");
    try {
      await callback();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const changeDraft = (text: string) => {
    setDraft(text);
    latestDraft.current = text;
    draftDirty.current = true;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftWrite.current = desktopApi()
        .moriAssistantSetDraft(text)
        .then(() => {
          if (latestDraft.current === text) draftDirty.current = false;
        })
        .catch((error) => setError(String(error)));
    }, 180);
  };
  const send = async () => {
    if (!draft.trim() || sending || !snapshot?.settings.enabled) return;
    const text = draft;
    setSending(true);
    setError("");
    if (draftTimer.current) clearTimeout(draftTimer.current);
    try {
      await draftWrite.current;
      await desktopApi().moriAssistantSend(text, crypto.randomUUID());
      if (latestDraft.current === text) {
        setDraft("");
        latestDraft.current = "";
        draftDirty.current = false;
        await desktopApi().moriAssistantSetDraft("");
      }
      followEnd.current = true;
      setAwayFromEnd(false);
      editor.current?.focus();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };
  const flushDraft = async () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    await draftWrite.current;
    if (draftDirty.current) {
      await desktopApi().moriAssistantSetDraft(latestDraft.current);
      draftDirty.current = false;
    }
  };
  const openSettings = () => {
    if (draftDirty.current) void flushDraft();
    setHistoryOpen(false);
    if (onSettings) onSettings();
    else setSettingsOpen(true);
  };
  const olderMessages = async () => {
    const cursor = olderCursor ?? snapshot?.messageCursor;
    if (!cursor || olderLoading) return;
    const height = feed.current?.scrollHeight ?? 0;
    const top = feed.current?.scrollTop ?? 0;
    setOlderLoading(true);
    followEnd.current = false;
    await perform(async () => {
      const page = await desktopApi().moriAssistantSnapshot(cursor);
      setOlder((current) => [...page.messages, ...current]);
      setOlderCursor(page.messageCursor);
      setOlderDone(!page.hasMoreMessages);
      requestAnimationFrame(() => {
        if (feed.current) feed.current.scrollTop = top + feed.current.scrollHeight - height;
      });
    });
    setOlderLoading(false);
  };
  const switchSession = async (id?: string) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    await perform(async () => {
      await flushDraft();
      if (id) await desktopApi().moriAssistantSelectSession(id);
      else await desktopApi().moriAssistantNewSession();
      setHistoryOpen(false);
      editor.current?.focus();
    });
    setSessionBusy(false);
  };
  const copyMessage = async (message: ConversationMessage) => {
    try {
      await navigator.clipboard.writeText(message.body);
      setCopiedId(message.messageId);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(""), 1800);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const updateConfig = async (patch: Partial<MoriAssistantSettings>) => {
    if (!snapshot || configSaving) return;
    setConfigSaving(true);
    await perform(() => desktopApi().moriAssistantSaveSettings({ ...snapshot.settings, ...patch }));
    setConfigSaving(false);
  };
  const insertPrompt = (text: string) => {
    changeDraft(text);
    editor.current?.focus();
  };
  const goToEnd = () => {
    followEnd.current = true;
    setAwayFromEnd(false);
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };
  const busy = snapshot?.status === "running" || snapshot?.status === "waiting";
  const seen = new Set<string>();
  const messages = [...older, ...(snapshot?.messages ?? [])].filter((message) => {
    if (seen.has(message.messageId)) return false;
    seen.add(message.messageId);
    return true;
  });
  return (
    <section className={`mori-panel ${floating ? "is-floating" : ""}`} aria-label={t("moriUi.moriAssistant.chatLabel")}>
      <header className="mori-panel-header">
        <span className="mori-mark">
          <MoriIcon
            animated
            mood={
              snapshot?.status === "waiting"
                ? "waiting"
                : snapshot?.status === "error"
                  ? "error"
                  : busy
                    ? "thinking"
                    : "idle"
            }
          />
        </span>
        <div className="mori-heading">
          <strong>{snapshot?.settings.name ?? "Mori"}</strong>
          <small>
            <span className={`mori-presence ${busy ? "is-busy" : ""}`} />
            {!snapshot
              ? "正在连接…"
              : !snapshot.settings.enabled
                ? "配置后即可开始"
                : stopping
                  ? "正在停止…"
                  : snapshot.status === "waiting"
                    ? pendingInput?.kind === "approval"
                      ? "等待你确认操作"
                      : "等待你的回答"
                    : busy
                      ? "正在处理"
                      : "随时可以开始"}
          </small>
        </div>
        <button
          type="button"
          title={t("moriUi.moriAssistant.history")}
          aria-label={t("moriUi.moriAssistant.history")}
          aria-expanded={historyOpen}
          aria-controls="mori-history"
          ref={historyTrigger}
          className={historyOpen ? "is-selected" : ""}
          onClick={() => {
            setHistoryOpen((value) => !value);
            setHistoryQuery("");
          }}
        >
          <History size={16} />
        </button>
        <button
          type="button"
          title={t("moriUi.moriAssistant.newChat")}
          aria-label={t("moriUi.moriAssistant.newChat")}
          disabled={sessionBusy}
          onClick={() => void switchSession()}
        >
          <Plus size={17} />
        </button>
        <button type="button" title={t("moriUi.moriAssistant.assistantSettings")} aria-label={t("moriUi.moriAssistant.assistantSettings")} onClick={openSettings}>
          <Settings size={16} />
        </button>
        {floating ? (
          <button
            type="button"
            title={t("moriUi.moriAssistant.expandMain")}
            aria-label={t("moriUi.moriAssistant.expandMain")}
            onClick={() =>
              void perform(async () => {
                await flushDraft();
                await desktopApi().moriAssistantShowMain();
              })
            }
          >
            <Maximize2 size={15} />
          </button>
        ) : null}
        <button
          type="button"
          title={floating ? "收起 Mori" : "返回工作页"}
          aria-label={floating ? "收起 Mori" : "返回工作页"}
          onClick={() =>
            void perform(async () => {
              await flushDraft();
              if (floating) await desktopApi().moriAssistantFloating(false);
              else onClose?.();
            })
          }
        >
          {floating ? <Minus size={17} /> : <ArrowLeft size={17} />}
        </button>
      </header>
      {historyOpen ? (
        <div className="mori-history" id="mori-history" ref={history}>
          <div className="mori-history-heading">
            <strong>{t("moriUi.moriAssistant.conversation")}</strong>
            <button
              type="button"
              aria-label={t("moriUi.moriAssistant.closeHistory")}
              onClick={() => {
                setHistoryOpen(false);
                historyTrigger.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
          <label className="mori-history-search">
            <Search size={14} />
            <input
              aria-label={t("moriUi.moriAssistant.searchHistory")}
              placeholder={t("moriUi.moriAssistant.searchPlaceholder")}
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
          </label>
          {busy ? <p className="mori-muted">{t("moriUi.moriAssistant.switchAfterReply")}</p> : null}
          <div className="mori-history-list">
            {snapshot?.sessions.length ? (
              snapshot.sessions
                .filter((item) => item.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()))
                .map((item) => (
                  <button
                    type="button"
                    key={item.threadId}
                    disabled={sessionBusy}
                    aria-current={item.threadId === snapshot.currentThreadId ? "true" : undefined}
                    className={item.threadId === snapshot.currentThreadId ? "is-selected" : ""}
                    onClick={() => void switchSession(item.threadId)}
                  >
                    <span>
                      {item.title}
                      <small>
                        {new Date(item.createdAt).toLocaleDateString("zh-CN", {
                          month: "short",
                          day: "numeric",
                        })}
                      </small>
                    </span>
                    {item.threadId === snapshot.currentThreadId ? <Check size={14} /> : null}
                  </button>
                ))
            ) : (
              <p>{t("moriUi.moriAssistant.noHistory")}</p>
            )}
            {snapshot?.sessions.length &&
            !snapshot.sessions.some((item) =>
              item.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()),
            ) ? (
              <p className="mori-muted">{t("moriUi.moriAssistant.noMatches")}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {settingsOpen ? (
        <div className="mori-embedded-settings">
          <button type="button" onClick={() => setSettingsOpen(false)}>
            <ArrowLeft size={14} />
            {t("moriUi.moriAssistant.backToChat")}
          </button>
          <MoriAssistantSettingsPanel onDone={() => setSettingsOpen(false)} />
        </div>
      ) : (
        <>
          <div
            className="mori-messages"
            ref={feed}
            onScroll={() => {
              const element = feed.current;
              if (element) {
                const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
                followEnd.current = nearEnd;
                setAwayFromEnd(!nearEnd);
              }
            }}
          >
            {!snapshot && !error ? <p role="status">{t("moriUi.moriAssistant.loading")}</p> : null}
            {snapshot && !snapshot.settings.enabled && !messages.length ? (
              <div className="mori-empty">
                <span className="mori-mark large">
                  <MoriIcon size={60} animated />
                </span>
                <h2>{t("moriUi.moriAssistant.greeting")}</h2>
                <p>{t("moriUi.moriAssistant.greetingHint")}</p>
                <div className="mori-onboarding">
                  <span>
                    <Check size={13} />
                    {t("moriUi.moriAssistant.chooseChatgpt")}
                  </span>
                  <span>
                    <Check size={13} />
                    {t("moriUi.moriAssistant.configureModel")}
                  </span>
                </div>
                <button type="button" className="mori-primary" onClick={openSettings}>
                  {t("moriUi.moriAssistant.configure")}
                </button>
              </div>
            ) : null}
            {snapshot?.settings.enabled && !messages.length ? (
              <div className="mori-empty">
                <span className="mori-mark large">
                  <MoriIcon size={60} animated />
                </span>
                <h2>{t("moriUi.moriAssistant.todayPrompt")}</h2>
                <p>{t("moriUi.moriAssistant.todayHint")}</p>
                <div className="mori-starters">
                  <button type="button" onClick={() => insertPrompt("帮我看看最近的工作会话，整理一下进展")}>
                    <History size={17} />
                    <span>
                      <strong>{t("moriUi.moriAssistant.resumeWork")}</strong>
                      <small>{t("moriUi.moriAssistant.resumeWorkHint")}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                  <button type="button" onClick={() => insertPrompt("帮我新建一个工作任务：")}>
                    <Plus size={17} />
                    <span>
                      <strong>{t("moriUi.moriAssistant.newTask")}</strong>
                      <small>{t("moriUi.moriAssistant.newTaskHint")}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertPrompt("看看有哪些任务正在运行，哪些需要我处理")}
                  >
                    <Sparkles size={17} />
                    <span>
                      <strong>{t("moriUi.moriAssistant.attention")}</strong>
                      <small>{t("moriUi.moriAssistant.attentionHint")}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            ) : null}
            {snapshot?.hasMoreMessages && !olderDone ? (
              <button
                className="mori-history-more"
                type="button"
                disabled={olderLoading}
                onClick={() => void olderMessages()}
              >
                {olderLoading ? <LoaderCircle size={13} className="spinning" /> : null}
                {olderLoading ? "正在加载…" : "查看更早的消息"}
              </button>
            ) : null}
            {snapshot && <MoriScheduledCards schedules={snapshot.schedules} occurrences={snapshot.scheduledOccurrences} onChanged={refresh} />}
            {snapshot?.activeThreadId && snapshot.activeThreadId !== snapshot.currentThreadId && <p className="mori-activity">{t("moriUi.moriAssistant.runningElsewhere")}<button type="button" onClick={() => void switchSession(snapshot.activeThreadId)}>{t("moriUi.moriAssistant.openRunningChat")}</button></p>}
            {messages.map((message) => (
              <article className={`mori-message is-${message.role}`} key={message.messageId}>
                <div className="mori-message-label">
                  {message.role === "user"
                    ? snapshot?.sourceByMessage[message.messageId] === "wechat"
                      ? "你 · 来自微信"
                      : snapshot?.sourceByMessage[message.messageId] === "task"
                        ? "任务更新"
                        : snapshot?.sourceByMessage[message.messageId] === "schedule" ? "定时操作" : "你"
                    : (snapshot?.settings.name ?? "Mori")}
                  {message.status === "queued"
                    ? " · 排队中"
                    : message.status === "cancelled"
                      ? " · 已停止"
                      : ""}
                </div>
                {message.role === "assistant" ? (
                  <MarkdownContent text={message.body} />
                ) : (
                  <p>{message.body}</p>
                )}
                {message.role === "assistant" && message.status !== "streaming" ? (
                  <div className="mori-message-actions">
                    <button
                      type="button"
                      aria-label={copiedId === message.messageId ? "已复制回复" : "复制回复"}
                      title={t("moriUi.moriAssistant.copyReply")}
                      onClick={() => void copyMessage(message)}
                    >
                      {copiedId === message.messageId ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copiedId === message.messageId ? "已复制" : "复制"}</span>
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
            {snapshot?.activity ? (
              <div className="mori-activity" role="status">
                <LoaderCircle size={13} className="spinning" />
                {snapshot.activity.startsWith("mori_") ? "正在操作桌面" : snapshot.activity}
              </div>
            ) : null}
            {snapshot?.tasks.length ? (
              <details className="mori-tasks" aria-label={t("moriUi.moriAssistant.tasksLabel")}>
                <summary>
                  <FolderOpen size={14} />
                  <span>{t("moriUi.moriAssistant.tasks")}</span>
                  <small>{snapshot.tasks.length}</small>
                  <ChevronDown size={13} />
                </summary>
                {snapshot.tasks.slice(-8).map((task) => (
                  <button
                    type="button"
                    key={task.id}
                    className="mori-task"
                    onClick={() => void perform(() => desktopApi().moriAssistantOpenTask(task.id))}
                  >
                    <span className={`mori-task-dot is-${task.status}`} />
                    <span>
                      <strong>{task.title}</strong>
                      <small>{taskStatus[task.status]}</small>
                    </span>
                    <ExternalLink size={13} />
                  </button>
                ))}
              </details>
            ) : null}
            {error || snapshot?.error ? (
              <p className="mori-error mori-chat-error" role="alert">
                {error || snapshot?.error}
              </p>
            ) : null}
            <div ref={end} />
          </div>
          {awayFromEnd ? (
            <button type="button" className="mori-to-latest" onClick={goToEnd}>
              <ArrowDown size={14} />
              {t("moriUi.moriAssistant.latest")}
            </button>
          ) : null}
          {pendingInput ? (
            <form
              className="mori-question"
              onSubmit={(event) => {
                event.preventDefault();
                if (pendingInput.kind === "approval" || answering || !answer.trim()) return;
                setAnswering(true);
                void perform(async () => {
                  await desktopApi().moriAssistantRespond(pendingInput.id, answer);
                  setAnswer("");
                }).finally(() => setAnswering(false));
              }}
            >
              <strong>{pendingInput.title}</strong>
              {pendingInput.detail ? <pre className="mori-approval-detail">{pendingInput.detail}</pre> : null}
              {pendingInput.kind === "approval" ? (
                <div className="mori-approval-actions">
                  {["拒绝", "允许"].map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      className={decision === "允许" ? "mori-primary" : ""}
                      disabled={answering}
                      onClick={() => {
                        setAnswering(true);
                        void perform(() =>
                          desktopApi().moriAssistantRespond(pendingInput.id, decision),
                        ).finally(() => setAnswering(false));
                      }}
                    >
                      {decision === "允许" ? "允许本次操作" : "拒绝"}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <input
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    placeholder={t("moriUi.moriAssistant.answerPlaceholder")}
                    aria-label={t("moriUi.moriAssistant.answerLabel")}
                    disabled={answering}
                  />
                  <button type="submit" disabled={!answer.trim() || answering}>
                    {answering ? <LoaderCircle size={13} className="spinning" /> : null}{t("moriUi.moriAssistant.answerContinue")}
                  </button>
                </>
              )}
            </form>
          ) : null}
          {snapshot && !snapshot.settings.enabled ? (
            <div className="mori-disabled-footer">
              <span>{t("moriUi.moriAssistant.configureToChat")}</span>
              {messages.length ? (
                <button type="button" className="mori-primary" onClick={openSettings}>
                  {t("moriUi.moriAssistant.configure")}
                  <ChevronRight size={14} />
                </button>
              ) : null}
            </div>
          ) : (
            <footer className="mori-composer">
              <textarea
                aria-label={t("moriUi.moriAssistant.messageLabel")}
                placeholder={snapshot?.settings.enabled ? "跟 Mori 说点什么…" : "先配置助手，再开始对话"}
                rows={2}
                ref={editor}
                value={draft}
                disabled={!snapshot?.settings.enabled}
                onChange={(event) => changeDraft(event.target.value)}
                onFocus={() => {
                  editorFocused.current = true;
                }}
                onBlur={() => {
                  editorFocused.current = false;
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (shortcutMatches(event, "composer-newline")) {
                    event.preventDefault();
                    const field = event.currentTarget;
                    const start = field.selectionStart;
                    const next = `${draft.slice(0, start)}\n${draft.slice(field.selectionEnd)}`;
                    changeDraft(next);
                    requestAnimationFrame(() => field.setSelectionRange(start + 1, start + 1));
                    return;
                  }
                  if (shortcutMatches(event, "composer-send")) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="mori-composer-bottom">
                <label className="mori-model" title={busy ? "回复结束后可切换模型" : "切换助手模型"}>
                  <Sparkles size={12} />
                  <select
                    aria-label={t("moriUi.moriAssistant.conversationModel")}
                    value={snapshot?.settings.model ?? ""}
                    disabled={busy || configSaving || !snapshot}
                    onChange={(event) => void updateConfig({ model: event.target.value })}
                  >
                    {[
                      ...new Set([
                        snapshot?.settings.model ?? "",
                        ...(snapshot?.settings.modelSource === "custom"
                          ? []
                          : ["gpt-6-luna", "gpt-6.1-terra"]),
                        ...(snapshot?.models.map((item) => item.id) ?? []),
                      ]),
                    ]
                      .filter(Boolean)
                      .map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                  </select>
                  <ChevronDown size={11} />
                </label>
                <span className="mori-composer-spacer" />
                {busy ? (
                  <button
                    type="button"
                    className="mori-stop"
                    title={t("moriUi.moriAssistant.stopAndCancelQueue")}
                    aria-label={t("moriUi.moriAssistant.stopReply")}
                    disabled={stopping}
                    onClick={() => {
                      setStopping(true);
                      void perform(() => desktopApi().moriAssistantCancel()).finally(() =>
                        setStopping(false),
                      );
                    }}
                  >
                    {stopping ? <LoaderCircle size={13} className="spinning" /> : <Square size={12} />}
                    <span>{stopping ? "停止中" : "停止"}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mori-send primary"
                  title={busy ? "排队发送" : "发送"}
                  aria-label={busy ? "排队发送" : "发送"}
                  disabled={!draft.trim() || sending || !snapshot?.settings.enabled}
                  onClick={() => void send()}
                >
                  {sending ? <LoaderCircle size={16} className="spinning" /> : <ArrowUp size={17} />}
                </button>
              </div>
              {busy ? (
                <div className="mori-composer-hint" role="status">
                  {t("moriUi.moriAssistant.queueHint")}
                </div>
              ) : null}
            </footer>
          )}
        </>
      )}
    </section>
  );
}

export function MoriAssistantSurface({ mode }: { mode: "ball" | "panel" | "notice" }) {
  const { t } = useTranslation();
  const { snapshot, error } = useAssistant();
  const [notice, setNotice] = useState<{ title: string; body: string; threadId: string }>();
  const [pet, setPet] = useState<MoriPetAsset | undefined>(DEFAULT_MORI_PET);
  const [petError, setPetError] = useState("");
  const [direction, setDirection] = useState<number | null>(null);
  const [dragAnimation, setDragAnimation] = useState<MoriPetAnimation>();
  const [reaction, setReaction] = useState<MoriPetAnimation>();
  const [greeting, setGreeting] = useState(false);
  const reactionTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const greetingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const inputHitMap = useRef<MoriPetHitMap | undefined>(undefined);
  const bodyHitMap = useRef<MoriPetHitMap | undefined>(undefined);
  const pointerInBody = useRef(false);
  const pointerPosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const updateHitMap = useCallback((map: MoriPetHitMap, bodyMap?: MoriPetHitMap) => {
    inputHitMap.current = map;
    bodyHitMap.current = bodyMap;
    void desktopApi().moriAssistantPetHitMap(map).catch((error) => setPetError(String(error)));
  }, []);
  useEffect(() => {
    if (mode !== "ball") return;
    const size = snapshot ? moriPetSize(snapshot.settings) : 64;
    if (pet && !petError) return;
    const alpha = new Uint8Array(size * size);
    if (petError) {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= 12) alpha[y * size + x] = 255;
    }
    updateHitMap({ width: size, height: size, alpha });
  }, [mode, pet, petError, snapshot?.settings.petKey, snapshot?.settings.petSizes, updateHitMap]);
  useEffect(() => {
    document.documentElement.dataset.moriSurface = mode;
    return () => {
      delete document.documentElement.dataset.moriSurface;
    };
  }, [mode]);
  useEffect(() => {
    if (mode !== "notice") return;
    const refresh = () => {
      void desktopApi().moriAssistantNotice().then(setNotice);
    };
    refresh();
    return desktopApi().onMoriAssistantChanged(refresh);
  }, [mode]);
  useEffect(() => {
    if (mode !== "ball") return;
    const offLook = desktopApi().onMoriPetLook(setDirection);
    const offReaction = desktopApi().onMoriPetReaction((kind) => {
      for (const timer of reactionTimers.current) clearTimeout(timer);
      reactionTimers.current = [];
      if (kind === "completion") {
        setReaction("jumping");
        reactionTimers.current.push(setTimeout(() => setReaction("review"), 1100));
        reactionTimers.current.push(setTimeout(() => setReaction(undefined), 5000));
      } else if (kind === "failed") {
        setReaction("failed");
        reactionTimers.current.push(setTimeout(() => setReaction(undefined), 4000));
      } else {
        setReaction("waiting");
        reactionTimers.current.push(setTimeout(() => setReaction(undefined), 12000));
      }
    });
    return () => {
      offLook();
      offReaction();
      for (const timer of reactionTimers.current) clearTimeout(timer);
      reactionTimers.current = [];
      if (greetingTimer.current) clearTimeout(greetingTimer.current);
    };
  }, [mode]);
  useEffect(() => {
    if (mode !== "ball") return;
    let active = true;
    const key = snapshot?.settings.petKey;
    inputHitMap.current = bodyHitMap.current = undefined;
    pointerInBody.current = false;
    pointerPosition.current = undefined;
    if (greetingTimer.current) clearTimeout(greetingTimer.current);
    greetingTimer.current = undefined;
    setGreeting(false);
    setPet(key ? undefined : DEFAULT_MORI_PET);
    setPetError("");
    if (key)
      void desktopApi()
        .moriPetAsset(key)
        .then((asset) => {
          if (active) setPet(asset);
        })
        .catch((error) => {
          if (active) setPetError(error instanceof Error ? error.message : String(error));
        });
    return () => {
      active = false;
    };
  }, [mode, snapshot?.settings.petKey]);
  if (mode === "panel") return <MoriAssistantPanel floating />;
  if (mode === "notice")
    return notice ? (
      <button
        className="mori-notice"
        type="button"
        onClick={() => void desktopApi().moriAssistantOpenNotice()}
      >
        <span className="mori-notice-label">{t("moriUi.moriAssistant.newActivity")}</span>
        <strong>{notice.title}</strong>
        <span className="mori-notice-body">{notice.body}</span>
      </button>
    ) : null;
  const status =
    snapshot?.status === "error"
      ? "error"
      : snapshot?.status === "waiting" || snapshot?.hasPendingTasks
        ? "waiting"
        : snapshot?.status === "running" || snapshot?.hasRunningTasks
          ? "running"
          : "idle";
  const animation: MoriPetAnimation =
    dragAnimation ??
    (greeting ? "waving" : undefined) ??
    reaction ??
    // A persistent task state must not suppress attention to the nearby pointer.
    // Direct interactions and reactions above still finish before looking around.
    (pet?.version === 2 && direction != null && status !== "error" && !petError
      ? "idle"
      : status === "running"
        ? "running"
        : status === "waiting"
          ? "waiting"
          : status === "error" || petError
            ? "failed"
            : "idle");
  const indicator =
    petError || status === "error" ? "error" : status === "waiting" ? "waiting" : undefined;
  const statusLabel =
    indicator === "error"
      ? "Mori 遇到错误，点击查看"
      : indicator === "waiting"
        ? "Mori 有待处理事项，点击查看"
        : "与 Mori 对话";
  const pointerHits = (
    event: { clientX: number; clientY: number; currentTarget: HTMLButtonElement },
    map: MoriPetHitMap | undefined,
  ) => {
    if (!map) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return moriPetHitTest(
      map,
      ((event.clientX - bounds.left) * map.width) / bounds.width,
      ((event.clientY - bounds.top) * map.height) / bounds.height,
    );
  };
  const greetOnBodyEntry = (
    event: {
      pointerType: string;
      clientX: number;
      clientY: number;
      screenX: number;
      screenY: number;
      currentTarget: HTMLButtonElement;
    },
  ) => {
    if (event.pointerType !== "mouse" || drag.current) return;
    const previous = pointerPosition.current;
    pointerPosition.current = { x: event.screenX, y: event.screenY };
    if (previous?.x === event.screenX && previous.y === event.screenY) return;
    const inside = pointerHits(event, bodyHitMap.current);
    const entered = inside && !pointerInBody.current;
    pointerInBody.current = inside;
    // Native input toggles and animation frames can generate boundary events.
    // A greeting starts only on a body hit and cannot restart its own timer.
    if (!entered || greetingTimer.current) return;
    setGreeting(true);
    greetingTimer.current = setTimeout(() => {
      greetingTimer.current = undefined;
      setGreeting(false);
    }, 700);
  };
  return (
    <button
      type="button"
      className={`mori-ball is-${status}`}
      title={petError || error || snapshot?.error || statusLabel}
      aria-label={petError ? `宠物加载失败：${petError}` : `${statusLabel}，打开或收起助手`}
      onPointerEnter={greetOnBodyEntry}
      onPointerLeave={(event) => {
        pointerInBody.current = false;
        pointerPosition.current = { x: event.screenX, y: event.screenY };
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !pointerHits(event, inputHitMap.current)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        void desktopApi().moriAssistantPetDragging(true).catch((error) => setPetError(String(error)));
        drag.current = { x: event.screenX, y: event.screenY, moved: false };
      }}
      onPointerMove={(event) => {
        if (!drag.current) {
          greetOnBodyEntry(event);
          return;
        }
        const dx = event.screenX - drag.current.x;
        const dy = event.screenY - drag.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          drag.current.moved = true;
          drag.current.x = event.screenX;
          drag.current.y = event.screenY;
          if (dx !== 0) setDragAnimation(dx > 0 ? "running-right" : "running-left");
          void desktopApi().moriAssistantMoveBall(dx, dy);
        }
      }}
      onPointerUp={() => {
        if (drag.current && !drag.current.moved) {
          void desktopApi().moriAssistantToggleFloating();
        }
        drag.current = undefined;
        setDragAnimation(undefined);
        void desktopApi().moriAssistantPetDragging(false).catch((error) => setPetError(String(error)));
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDragAnimation(undefined);
        void desktopApi().moriAssistantPetDragging(false).catch((error) => setPetError(String(error)));
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
        setDragAnimation(undefined);
        void desktopApi().moriAssistantPetDragging(false).catch((error) => setPetError(String(error)));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void desktopApi().moriAssistantToggleFloating();
        }
      }}
    >
      {pet && !petError ? (
        <MoriPetSprite
          pet={pet}
          animation={animation}
          direction={direction}
          size={snapshot ? moriPetSize(snapshot.settings) : 64}
          onError={setPetError}
          indicator={indicator}
          onHitMap={updateHitMap}
        />
      ) : null}
      {petError ? (
        <span className="mori-pet-load-error" aria-hidden="true">!</span>
      ) : null}
    </button>
  );
}
