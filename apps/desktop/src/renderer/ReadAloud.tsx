import {
  AlertCircle,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  Cloud,
  LoaderCircle,
  Monitor,
  Square,
  Volume2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { markdownToSpeechText, splitSpeechText } from "../shared/speech-text";
import {
  CLEAR_READ_ALOUD_STYLE,
  DEFAULT_READ_ALOUD_STYLE,
  defaultReadAloudVoice,
  type ReadAloudEngine,
  type ReadAloudSettingsInput,
  type ReadAloudSettingsSnapshot,
} from "../shared/tts";
import {
  type AutoReadCandidate,
  ReadAloudAutoReadTracker,
  ReadAloudController,
  type ReadAloudPlayer,
} from "./read-aloud-controller";

class DesktopReadAloudPlayer implements ReadAloudPlayer {
  private finish: ((error?: Error) => void) | undefined;
  private generation = 0;
  stop(): void {
    ++this.generation;
    this.finish?.(new Error("朗读已停止。"));
  }
  play(bytes: Uint8Array, mimeType: string, onStarted: () => void): Promise<void> {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    const audio = new Audio(url);
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (this.finish !== finish) return;
        this.finish = undefined;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        if (error) reject(error);
        else resolve();
      };
      this.finish = finish;
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("朗读音频播放失败。"));
      void audio
        .play()
        .then(() => {
          if (this.finish === finish) onStarted();
        })
        .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }
  async speak(sourceText: string, onStarted: () => void): Promise<void> {
    if (!("speechSynthesis" in window)) throw new Error("当前设备不支持系统朗读。");
    const generation = this.generation;
    const engine = window.speechSynthesis;
    let voices = engine.getVoices();
    if (!voices.length) {
      await new Promise<void>((resolve) => {
        const done = () => {
          engine.removeEventListener("voiceschanged", done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        engine.addEventListener("voiceschanged", done, { once: true });
      });
      voices = engine.getVoices();
    }
    if (generation !== this.generation) return;
    const text = markdownToSpeechText(sourceText);
    if (!text) throw new Error("正文中没有可朗读的内容。");
    const language = /[\u3400-\u9fff]/u.test(text) ? /^(zh|cmn|yue)/i : /^en/i;
    const selectedVoice = localStorage.getItem("eco.readAloud.systemVoice");
    const voice = selectedVoice
      ? voices.find((entry) => entry.localService && entry.voiceURI === selectedVoice)
      : voices.find((entry) => entry.localService && language.test(entry.lang));
    if (selectedVoice && !voice) throw new Error("所选系统音色已不可用，请在朗读面板中重新选择。");
    if (!voice) throw new Error("当前设备没有适用于正文语言的系统本地音色。");
    for (const segment of splitSpeechText(text)) {
      if (generation !== this.generation) return;
      await new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(segment);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        const finish = (error?: Error) => {
          if (this.finish !== finish) return;
          this.finish = undefined;
          utterance.onend = null;
          utterance.onerror = null;
          utterance.onstart = null;
          if (error) {
            engine.cancel();
            reject(error);
          } else resolve();
        };
        this.finish = finish;
        utterance.onstart = onStarted;
        utterance.onend = () => finish();
        utterance.onerror = (event) => finish(new Error(`系统朗读失败：${event.error}`));
        engine.speak(utterance);
      });
    }
  }
}

const storedEngine =
  typeof localStorage === "undefined" ? null : localStorage.getItem("eco.readAloud.engine");
export const readAloud = new ReadAloudController(
  () => {
    if (!window.eco?.startReadAloud) throw new Error("当前桌面版本不支持正文朗读，请升级 Mori。");
    return window.eco;
  },
  new DesktopReadAloudPlayer(),
  {
    engine: storedEngine === "system" ? "system" : "online",
    autoRead:
      typeof localStorage !== "undefined" && localStorage.getItem("eco.readAloud.autoRead") === "true",
  },
);
export const ReadAloudThreadContext = createContext("");
export const useReadAloud = () =>
  useSyncExternalStore(readAloud.subscribe, readAloud.getSnapshot, readAloud.getSnapshot);

export function ReadAloudButton({ entryId, sourceText }: { entryId: string; sourceText: string }) {
  const threadId = useContext(ReadAloudThreadContext);
  const playback = useSyncExternalStore(
    readAloud.subscribe,
    () => {
      const snapshot = readAloud.getSnapshot();
      return snapshot.threadId === threadId && snapshot.entryId === entryId ? snapshot.state : "idle";
    },
    () => "idle",
  );
  const { t } = useTranslation();
  if (!threadId) return null;
  const active = playback === "preparing" || playback === "speaking";
  const preparing = playback === "preparing";
  return (
    <button
      type="button"
      className={`run-log-message-meta-button read-aloud-message-button${active ? " is-reading" : ""}${playback === "failed" ? " is-failed" : ""}`}
      title={t(preparing ? "readAloud.preparing" : active ? "readAloud.stop" : "readAloud.speak")}
      aria-label={t(active ? "readAloud.stop" : "readAloud.speak")}
      aria-pressed={active}
      onClick={() => {
        if (active) readAloud.stop();
        else void readAloud.speak(threadId, entryId, sourceText);
      }}
    >
      {preparing ? (
        <LoaderCircle size={13} className="tts-artifact-spinner" aria-hidden />
      ) : active ? (
        <Square size={12} fill="currentColor" aria-hidden />
      ) : playback === "failed" ? (
        <AlertCircle size={13} aria-hidden />
      ) : (
        <Volume2 size={13} aria-hidden />
      )}
    </button>
  );
}

function setReadAloudEngine(engine: ReadAloudEngine) {
  if (readAloud.getSnapshot().engine === engine) return;
  readAloud.setEngine(engine);
  localStorage.setItem("eco.readAloud.engine", engine);
}

function setReadAloudAutoRead(enabled: boolean) {
  readAloud.setAutoRead(enabled);
  localStorage.setItem("eco.readAloud.autoRead", String(enabled));
}

function ReadAloudEngineChoice() {
  const { engine } = useReadAloud();
  const { t } = useTranslation();
  return (
    <fieldset
      className="settings-segmented-control read-aloud-engine-choice"
      aria-label={t("readAloud.engine")}
    >
      <button
        type="button"
        className={engine === "online" ? "active" : undefined}
        aria-pressed={engine === "online"}
        onClick={() => setReadAloudEngine("online")}
      >
        <Cloud size={14} aria-hidden />
        {t("readAloud.online")}
      </button>
      <button
        type="button"
        className={engine === "system" ? "active" : undefined}
        aria-pressed={engine === "system"}
        onClick={() => setReadAloudEngine("system")}
      >
        <Monitor size={14} aria-hidden />
        {t("readAloud.system")}
      </button>
    </fieldset>
  );
}

function ReadAloudAutoReadSwitch() {
  const { autoRead } = useReadAloud();
  const { t } = useTranslation();
  return (
    <label className="composer-switch browser-settings-switch">
      <input
        type="checkbox"
        checked={autoRead}
        aria-label={t("readAloud.autoRead")}
        onChange={(event) => setReadAloudAutoRead(event.target.checked)}
      />
      <span className="composer-switch-track" aria-hidden />
    </label>
  );
}

export function ReadAloudControls({
  threadId,
  onOpenSettings,
}: {
  threadId: string;
  onOpenSettings: () => void;
}) {
  const state = useReadAloud();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const active = state.threadId === threadId && (state.state === "preparing" || state.state === "speaking");
  const error = state.threadId === threadId ? state.error : undefined;
  useEffect(() => {
    if (!threadId) return;
    readAloud.stop();
    setOpen(false);
    const stopHidden = () => {
      if (document.hidden) readAloud.stop();
    };
    document.addEventListener("visibilitychange", stopHidden);
    const stopBlurred = () => readAloud.stop();
    window.addEventListener("blur", stopBlurred);
    return () => {
      document.removeEventListener("visibilitychange", stopHidden);
      window.removeEventListener("blur", stopBlurred);
      readAloud.stop();
    };
  }, [threadId]);
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(368, window.innerWidth - 24);
      setPanelStyle({
        position: "fixed",
        width,
        top: rect.bottom + 8,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        maxHeight: window.innerHeight - rect.bottom - 20,
      });
    };
    position();
    panelRef.current?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return (
    <>
      <div className="read-aloud-toolbar">
        <button
          ref={triggerRef}
          type="button"
          className={`codex-main-toolbar-button read-aloud-toolbar-trigger${open ? " is-active" : ""}${error ? " has-error" : ""}`}
          aria-label={t("readAloud.title")}
          title={t("readAloud.title")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {error ? <AlertCircle size={15} aria-hidden /> : <Volume2 size={15} aria-hidden />}
          {state.autoRead && !error ? <i className="read-aloud-auto-dot" aria-hidden /> : null}
        </button>
        {active ? (
          <button
            type="button"
            className="read-aloud-toolbar-stop"
            onClick={() => readAloud.stop()}
            title={t("readAloud.stop")}
            aria-label={t("readAloud.stop")}
          >
            {state.state === "preparing" ? (
              <LoaderCircle size={13} className="tts-artifact-spinner" aria-hidden />
            ) : (
              <Square size={10} fill="currentColor" aria-hidden />
            )}
            <span>
              {t(state.state === "preparing" ? "readAloud.preparingLabel" : "readAloud.speakingLabel")}
            </span>
          </button>
        ) : null}
      </div>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="read-aloud-popover"
              style={panelStyle}
              role="dialog"
              aria-label={t("readAloud.title")}
              tabIndex={-1}
            >
              <header className="read-aloud-popover-heading">
                <span>
                  <AudioLines size={17} aria-hidden />
                  <strong>{t("readAloud.title")}</strong>
                </span>
                <button
                  type="button"
                  className="read-aloud-icon-button"
                  aria-label={t("readAloud.close")}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <X size={15} aria-hidden />
                </button>
              </header>
              <div className="read-aloud-popover-body">
                <ReadAloudEngineChoice />
                {state.engine === "system" ? (
                  <p className="read-aloud-help">{t("readAloud.systemHint")}</p>
                ) : null}
                <ReadAloudConfiguration
                  onManageProviders={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                />
                <div className="read-aloud-auto-row">
                  <div>
                    <strong>{t("readAloud.autoRead")}</strong>
                    <small>{t("readAloud.autoReadHint")}</small>
                  </div>
                  <ReadAloudAutoReadSwitch />
                </div>
                {error ? (
                  <div className="read-aloud-error" role="alert">
                    <AlertCircle size={15} aria-hidden />
                    <p>{error}</p>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const READ_ALOUD_VOICES = {
  gemini: ["Kore", "Puck", "Aoede", "Charon", "Fenrir", "Leda", "Orus", "Zephyr"].map((voice) => ({
    value: voice,
    label: voice,
  })),
  doubao: [
    { value: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0" },
    { value: "zh_female_xiaohe_uranus_bigtts", label: "小何 2.0" },
    { value: "zh_male_m191_uranus_bigtts", label: "云舟 2.0" },
    { value: "zh_male_taocheng_uranus_bigtts", label: "小天 2.0" },
    { value: "zh_female_qingxinnvsheng_uranus_bigtts", label: "清新女声 2.0" },
    { value: "en_male_tim_uranus_bigtts", label: "Tim · English" },
    { value: "en_female_dacey_uranus_bigtts", label: "Dacey · English" },
  ],
};

const READ_ALOUD_STYLES = [
  { value: "relaxed", label: "readAloud.styleRelaxed", text: DEFAULT_READ_ALOUD_STYLE },
  { value: "clear", label: "readAloud.styleClear", text: CLEAR_READ_ALOUD_STYLE },
] as const;

function ReadAloudConfiguration({ onManageProviders }: { onManageProviders: () => void }) {
  const { engine } = useReadAloud();
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ReadAloudSettingsSnapshot>();
  const [form, setForm] = useState<ReadAloudSettingsInput>();
  const [issue, setIssue] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (!window.eco?.getReadAloudSettings) {
      setIssue(t("readAloud.upgrade"));
      return;
    }
    void window.eco
      .getReadAloudSettings()
      .then((snapshot) => {
        if (!disposed) {
          setSettings(snapshot);
          setForm(snapshot);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setIssue(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
    };
  }, [t]);
  if (engine === "system") return <SystemReadAloudVoices />;
  if (!form || !settings)
    return (
      <p className={issue ? "read-aloud-error" : "read-aloud-help"} role={issue ? "alert" : "status"}>
        {issue || t("readAloud.loading")}
      </p>
    );
  const profile = settings.profiles.find((entry) => entry.id === form.profileId);
  const presets =
    profile && profile.provider !== "openai_compatible" ? READ_ALOUD_VOICES[profile.provider] : undefined;
  const dirty =
    settings.profileId !== form.profileId || settings.voice !== form.voice || settings.style !== form.style;
  async function save() {
    if (!form || saving) return;
    setSaving(true);
    setIssue("");
    readAloud.stop();
    try {
      if (!window.eco?.saveReadAloudSettings) throw new Error(t("readAloud.upgrade"));
      const snapshot = await window.eco.saveReadAloudSettings(form);
      setSettings(snapshot);
      setForm(snapshot);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="read-aloud-configuration">
      <label className="read-aloud-field">
        <span>{t("readAloud.provider")}</span>
        <span className="read-aloud-select">
          <select
            value={form.profileId}
            disabled={saving}
            onChange={(event) => {
              readAloud.stop();
              const next = settings.profiles.find((entry) => entry.id === event.target.value);
              if (!next) return;
              setForm(
                next.id === settings.profileId
                  ? settings
                  : {
                      profileId: next.id,
                      voice: defaultReadAloudVoice(next.provider),
                      style: DEFAULT_READ_ALOUD_STYLE,
                    },
              );
            }}
          >
            {!profile ? <option value="">{t("readAloud.chooseProvider")}</option> : null}
            {settings.profiles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden />
        </span>
        {profile ? <small>{profile.model}</small> : null}
      </label>
      <label className="read-aloud-field" htmlFor="reader-voice">
        <span>{t("readAloud.voice")}</span>
        {presets ? (
          <span className="read-aloud-select">
            <select
              id="reader-voice"
              value={form.voice}
              disabled={saving}
              onChange={(event) => setForm({ ...form, voice: event.target.value })}
            >
              {!presets.some((voice) => voice.value === form.voice) ? (
                <option value={form.voice}>{form.voice || t("readAloud.voiceMissing")}</option>
              ) : null}
              {presets.map((voice) => (
                <option key={voice.value} value={voice.value}>
                  {voice.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden />
          </span>
        ) : (
          <input
            id="reader-voice"
            value={form.voice}
            maxLength={256}
            disabled={saving || !profile}
            placeholder={t("readAloud.voiceHint")}
            onChange={(event) => setForm({ ...form, voice: event.target.value })}
          />
        )}
      </label>
      <div className="read-aloud-field">
        <label htmlFor="reader-style">{t("readAloud.style")}</label>
        <span className="read-aloud-select">
          <select
            id="reader-style"
            value={READ_ALOUD_STYLES.find((preset) => preset.text === form.style)?.value ?? "custom"}
            disabled={saving || !profile}
            onChange={(event) => {
              const preset = READ_ALOUD_STYLES.find((entry) => entry.value === event.target.value);
              if (preset) setForm({ ...form, style: preset.text });
            }}
          >
            {READ_ALOUD_STYLES.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {t(preset.label)}
              </option>
            ))}
            <option value="custom" disabled>
              {t("readAloud.styleCustom")}
            </option>
          </select>
          <ChevronDown size={14} aria-hidden />
        </span>
        <textarea
          aria-label={t("readAloud.styleDetails")}
          value={form.style}
          rows={3}
          maxLength={4000}
          disabled={saving || !profile}
          onChange={(event) => setForm({ ...form, style: event.target.value })}
        />
      </div>
      {!profile?.hasApiKey ? (
        <div className="read-aloud-provider-notice">
          <span>{t(profile ? "readAloud.keyMissing" : "readAloud.profileMissing")}</span>
          <button type="button" className="settings-text-button" onClick={onManageProviders}>
            {t("readAloud.manageProviders")}
            <ArrowUpRight size={12} aria-hidden />
          </button>
        </div>
      ) : null}
      {issue ? (
        <div className="read-aloud-error" role="alert">
          <AlertCircle size={15} aria-hidden />
          <p>{issue}</p>
        </div>
      ) : null}
      <button
        type="button"
        className="read-aloud-save"
        disabled={!dirty || saving || !profile || !form.voice.trim() || !form.style.trim()}
        onClick={() => void save()}
      >
        {saving ? (
          <LoaderCircle size={14} className="tts-artifact-spinner" aria-hidden />
        ) : !dirty ? (
          <Check size={14} aria-hidden />
        ) : null}
        {t(saving ? "readAloud.saving" : dirty ? "readAloud.save" : "readAloud.saved")}
      </button>
    </div>
  );
}

function SystemReadAloudVoices() {
  const { t } = useTranslation();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem("eco.readAloud.systemVoice") ?? "");
  useEffect(() => {
    const speech = window.speechSynthesis;
    if (!speech) return;
    const update = () =>
      setVoices([
        ...new Map(
          speech
            .getVoices()
            .filter((voice) => voice.localService)
            .map((voice) => [voice.voiceURI, voice]),
        ).values(),
      ]);
    update();
    speech.addEventListener("voiceschanged", update);
    return () => speech.removeEventListener("voiceschanged", update);
  }, []);
  return (
    <div className="read-aloud-configuration">
      <label className="read-aloud-field">
        <span>{t("readAloud.voice")}</span>
        <span className="read-aloud-select">
          <select
            value={selected}
            disabled={!voices.length}
            onChange={(event) => {
              readAloud.stop();
              setSelected(event.target.value);
              localStorage.setItem("eco.readAloud.systemVoice", event.target.value);
            }}
          >
            <option value="">
              {t(voices.length ? "readAloud.voiceByLanguage" : "readAloud.noLocalVoice")}
            </option>
            {selected && !voices.some((voice) => voice.voiceURI === selected) ? (
              <option value={selected}>{t("readAloud.selectedVoiceUnavailable")}</option>
            ) : null}
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} · {voice.lang}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden />
        </span>
      </label>
    </div>
  );
}

export function useReadAloudAutoRead(
  threadId: string,
  running: boolean,
  candidate: AutoReadCandidate | undefined,
  runningRunId?: string,
): void {
  const autoRead = useSyncExternalStore(
    readAloud.subscribe,
    () => readAloud.getSnapshot().autoRead,
    () => false,
  );
  const candidateId = candidate?.id;
  const candidateText = candidate?.text;
  const candidateRunId = candidate?.runId;
  const tracker = useRef(new ReadAloudAutoReadTracker());
  useEffect(() => {
    const resetHidden = () => {
      if (document.hidden) tracker.current = new ReadAloudAutoReadTracker();
    };
    document.addEventListener("visibilitychange", resetHidden);
    const resetBlurred = () => {
      tracker.current = new ReadAloudAutoReadTracker();
    };
    window.addEventListener("blur", resetBlurred);
    return () => {
      document.removeEventListener("visibilitychange", resetHidden);
      window.removeEventListener("blur", resetBlurred);
    };
  }, []);
  useEffect(() => {
    const next = tracker.current.observe(
      threadId,
      running,
      candidateId && candidateText !== undefined
        ? { id: candidateId, text: candidateText, ...(candidateRunId && { runId: candidateRunId }) }
        : undefined,
      autoRead && !document.hidden && document.hasFocus(),
      runningRunId,
    );
    if (next) void readAloud.speak(threadId, next.id, next.text);
  }, [threadId, running, candidateId, candidateText, candidateRunId, autoRead, runningRunId]);
}
