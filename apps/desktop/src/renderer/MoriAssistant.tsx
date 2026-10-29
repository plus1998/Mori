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
      <section className="mori-settings mori-manage-accounts" aria-label="助手账号管理">
        <button
          type="button"
          className="mori-text-button"
          onClick={() => {
            setAccountsOpen(false);
            void refresh();
          }}
        >
          <ArrowLeft size={14} />
          返回助手设置
        </button>
        <Suspense fallback={<p role="status">正在读取账号…</p>}>
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
  const missingProvider = custom && !selectedProvider;
  const invalid =
    missingAccount ||
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
    <section className="mori-settings" aria-label="Mori 设置">
      <div className="mori-settings-heading">
        <span className="mori-mark">
          <MoriIcon />
        </span>
        <div>
          <h2>Mori</h2>
          <p>对话、安排工作，在桌面和微信之间随时继续。</p>
        </div>
        <span className={`mori-status-pill ${snapshot.settings.enabled ? "is-ready" : ""}`}>
          {snapshot.settings.enabled ? "已启用" : "未启用"}
        </span>
      </div>
      <label className="mori-toggle mori-enable">
        <span>
          <strong>启用助手</strong>
          <small>选择模型来源，保存后即可开始对话。</small>
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
      <nav className="mori-settings-tabs" aria-label="助手设置分类">
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
          Mori 正在处理消息，回复结束后可修改设置。
        </p>
      ) : null}
      <fieldset disabled={locked}>
        {tab === "conversation" ? (
          <>
            <section className="mori-settings-section">
              <div className="mori-section-heading">
                <h3>模型来源</h3>
              </div>
              <label>
                使用方式
                <select
                  aria-label="助手模型来源"
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
                  <option value="chatgpt">ChatGPT 账号</option>
                  <option value="custom">自定义模型</option>
                </select>
              </label>
              {custom ? (
                <>
                  <label>
                    服务商
                    <select
                      aria-label="助手模型服务商"
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
                      <option value="">请选择服务商</option>
                      {settings.providerId && !selectedProvider ? (
                        <option value={settings.providerId}>当前服务商不可用</option>
                      ) : null}
                      {snapshot.customProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mori-muted">使用“设置 → 服务商”中已启用的服务商和模型。</p>
                  {missingProvider ? (
                    <p className="mori-field-error">
                      请先在“设置 → 服务商”中配置并启用服务商，再在这里选择。
                    </p>
                  ) : null}
                </>
              ) : null}
            </section>
            {!custom ? (
              <section className="mori-settings-section">
                <div className="mori-section-heading">
                  <h3>使用哪个账号</h3>
                  <small>可与工作会话共用</small>
                </div>
                {snapshot.accounts.length === 0 ? (
                  <div className="mori-account-empty">
                    <p>还没有 ChatGPT 账号，先登录一个账号即可继续。</p>
                    <button type="button" onClick={manageAccounts}>
                      添加 ChatGPT 账号
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
                {missingAccount ? <p className="mori-field-error">选择至少一个账号后保存。</p> : null}
                {snapshot.accounts.length > 0 ? (
                  <button type="button" className="mori-text-button" onClick={manageAccounts}>
                    管理账号
                    <ExternalLink size={12} />
                  </button>
                ) : null}
                <label className="mori-check">
                  <input
                    type="checkbox"
                    checked={settings.autoSwitchAccounts}
                    onChange={(event) => patch("autoSwitchAccounts", event.target.checked)}
                  />
                  额度耗尽时，按勾选顺序切换账号
                </label>
              </section>
            ) : null}
            <section className="mori-settings-section">
              <div className="mori-section-heading">
                <h3>对话偏好</h3>
              </div>
              <div className="mori-settings-grid">
                <label>
                  模型
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
                  思考强度
                  <select
                    value={settings.reasoningEffort}
                    onChange={(event) =>
                      patch("reasoningEffort", event.target.value as MoriAssistantSettings["reasoningEffort"])
                    }
                  >
                    <option value="low">低 · 更快响应</option>
                    <option value="medium">中 · 均衡</option>
                    <option value="high">高 · 深入思考</option>
                  </select>
                </label>
              </div>
              <p className="mori-workspace-note">
                <FolderOpen size={14} />
                <span>Mori 使用独立工作区。安排工作任务时，会为任务选择对应的项目。</span>
              </p>
              <details className="mori-personality">
                <summary>
                  名称与助手指令
                  <ChevronDown size={14} />
                </summary>
                <div>
                  <label>
                    助手名称
                    <input
                      value={settings.name}
                      maxLength={60}
                      aria-invalid={!settings.name.trim()}
                      onChange={(event) => patch("name", event.target.value)}
                    />
                  </label>
                  <label>
                    助手指令
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
              <h3>随时呼出 Mori</h3>
            </div>
            <div className="mori-computer-capability">
              <div>
                <Monitor size={16} />
                <strong>电脑操作</strong>
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
                  电脑操作设置
                  <ChevronRight size={13} />
                </button>
              ) : (
                <small>可在主窗口的「设置 → 电脑操作」中管理。</small>
              )}
            </div>
            <label className="mori-toggle">
              <span>
                <strong>桌面悬浮球</strong>
                <small>点击开始对话，拖动调整位置。</small>
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
                <strong>关闭窗口后继续运行</strong>
                <small>在托盘保留 Mori，继续接收微信和任务消息。</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.backgroundEnabled}
                aria-checked={settings.backgroundEnabled}
                onChange={(event) => patch("backgroundEnabled", event.target.checked)}
              />
            </label>
            <p className="mori-settings-hint">呼出快捷键可在「设置 → 键盘快捷键」中修改。</p>
          </section>
        ) : null}
        {tab === "wechat" ? (
          <section className="mori-settings-section mori-wechat">
            <label className="mori-toggle">
              <span>
                <strong>通过微信呼叫 Mori</strong>
                <small>与桌面共享对话，接收回复和任务进展。</small>
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
                    解除连接
                  </button>
                ) : null}
              </div>
              {!settings.enabled || !settings.wechatEnabled ? (
                <small>先启用助手和微信接收，再生成二维码。</small>
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
              处理较久时显示微信原生“正在输入”；等待你回答时暂停，不额外发送处理中消息。
            </p>
            <p className="mori-muted">支持文字和已转写的语音；图片、文件、视频及扫码验证码暂不支持。</p>
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
                已保存
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
              撤销更改
            </button>
          ) : null}
          <button
            type="button"
            className="mori-primary"
            disabled={locked || invalid || !dirty}
            onClick={() => void action(persist)}
          >
            {busy ? <LoaderCircle size={14} className="spinning" /> : null}保存设置
          </button>
          {snapshot.settings.enabled && !dirty ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => (onDone ? onDone() : void action(() => desktopApi().moriAssistantShowMain()))}
            >
              开始对话
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
    <section className={`mori-panel ${floating ? "is-floating" : ""}`} aria-label="Mori 助手对话">
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
          title="历史对话"
          aria-label="历史对话"
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
          title="新建助手对话"
          aria-label="新建助手对话"
          disabled={busy || sessionBusy}
          onClick={() => void switchSession()}
        >
          <Plus size={17} />
        </button>
        <button type="button" title="助手设置" aria-label="助手设置" onClick={openSettings}>
          <Settings size={16} />
        </button>
        {floating ? (
          <button
            type="button"
            title="在主窗口展开"
            aria-label="在主窗口展开"
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
            <strong>助手对话</strong>
            <button
              type="button"
              aria-label="关闭历史对话"
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
              aria-label="搜索助手对话"
              placeholder="搜索对话…"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
          </label>
          {busy ? <p className="mori-muted">回复结束后可切换对话</p> : null}
          <div className="mori-history-list">
            {snapshot?.sessions.length ? (
              snapshot.sessions
                .filter((item) => item.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()))
                .map((item) => (
                  <button
                    type="button"
                    key={item.threadId}
                    disabled={busy || sessionBusy}
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
              <p>还没有历史对话</p>
            )}
            {snapshot?.sessions.length &&
            !snapshot.sessions.some((item) =>
              item.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()),
            ) ? (
              <p className="mori-muted">没有匹配的对话</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {settingsOpen ? (
        <div className="mori-embedded-settings">
          <button type="button" onClick={() => setSettingsOpen(false)}>
            <ArrowLeft size={14} />
            返回对话
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
            {!snapshot && !error ? <p role="status">正在读取 Mori…</p> : null}
            {snapshot && !snapshot.settings.enabled && !messages.length ? (
              <div className="mori-empty">
                <span className="mori-mark large">
                  <MoriIcon size={60} animated />
                </span>
                <h2>你好，我是 Mori</h2>
                <p>告诉我你想做什么，我会帮你安排任务、查找对话和跟进进度。</p>
                <div className="mori-onboarding">
                  <span>
                    <Check size={13} />
                    选择 ChatGPT 账号
                  </span>
                  <span>
                    <Check size={13} />
                    设置对话模型
                  </span>
                </div>
                <button type="button" className="mori-primary" onClick={openSettings}>
                  配置助手
                </button>
              </div>
            ) : null}
            {snapshot?.settings.enabled && !messages.length ? (
              <div className="mori-empty">
                <span className="mori-mark large">
                  <MoriIcon size={60} animated />
                </span>
                <h2>今天想做些什么？</h2>
                <p>可以让我查找会话、开始工作，或跟进任务进度。</p>
                <div className="mori-starters">
                  <button type="button" onClick={() => insertPrompt("帮我看看最近的工作会话，整理一下进展")}>
                    <History size={17} />
                    <span>
                      <strong>接着上次的工作</strong>
                      <small>查找最近的会话和进展</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                  <button type="button" onClick={() => insertPrompt("帮我新建一个工作任务：")}>
                    <Plus size={17} />
                    <span>
                      <strong>开始一项新任务</strong>
                      <small>告诉我目标，一起开始</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertPrompt("看看有哪些任务正在运行，哪些需要我处理")}
                  >
                    <Sparkles size={17} />
                    <span>
                      <strong>看看哪些需要关注</strong>
                      <small>跟进运行中的任务</small>
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
            {messages.map((message) => (
              <article className={`mori-message is-${message.role}`} key={message.messageId}>
                <div className="mori-message-label">
                  {message.role === "user"
                    ? snapshot?.sourceByMessage[message.messageId] === "wechat"
                      ? "你 · 来自微信"
                      : snapshot?.sourceByMessage[message.messageId] === "task"
                        ? "任务更新"
                        : "你"
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
                      title="复制回复"
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
              <details className="mori-tasks" aria-label="助手工作任务">
                <summary>
                  <FolderOpen size={14} />
                  <span>Mori 的工作任务</span>
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
              回到最新消息
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
                    placeholder="输入回答"
                    aria-label="回答 Mori"
                    disabled={answering}
                  />
                  <button type="submit" disabled={!answer.trim() || answering}>
                    {answering ? <LoaderCircle size={13} className="spinning" /> : null}回答并继续
                  </button>
                </>
              )}
            </form>
          ) : null}
          {snapshot && !snapshot.settings.enabled ? (
            <div className="mori-disabled-footer">
              <span>配置账号和模型，开始与 Mori 对话</span>
              {messages.length ? (
                <button type="button" className="mori-primary" onClick={openSettings}>
                  配置助手
                  <ChevronRight size={14} />
                </button>
              ) : null}
            </div>
          ) : (
            <footer className="mori-composer">
              <textarea
                aria-label="给 Mori 发消息"
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
                    aria-label="助手对话模型"
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
                    title="停止当前回复和排队消息"
                    aria-label="停止回复"
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
                  新消息会排队发送 · 停止将取消排队消息
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
        <span className="mori-notice-label">Mori · 有新动态</span>
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
