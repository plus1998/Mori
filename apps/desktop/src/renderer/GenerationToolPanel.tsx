import { ChevronRight, ImagePlus, LoaderCircle, RefreshCw, Settings2, WandSparkles, X } from "lucide-react";
import { type ClipboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type GenerationToolContext,
  type GenerationToolRequest,
  generationToolScopeId,
} from "../shared/generation-tools";
import type {
  ImageGenerationArtifact,
  ImageGenerationSettingsSnapshot,
  ImageGenerationToolInput,
} from "../shared/image-generation";
import {
  IMAGE_ASPECT_PRESETS,
  IMAGE_RESOLUTION_PRESETS,
  type ImageResolutionPreset,
  imagePresetParameters,
  isValidCustomImageSize,
  supportsCustomImageDimensions,
} from "../shared/image-generation-presets";
import {
  defaultReadAloudVoice,
  type TtsArtifact,
  type TtsSettingsSnapshot,
  type TtsToolInput,
} from "../shared/tts";
import { COMPOSER_MAX_IMAGE_BYTES, readImageFileAsAttachment } from "./composer-attachments";
import { ImageGenerationArtifactDetail } from "./ImageGenerationArtifactDetail";
import { i18n } from "./i18n";
import { revokeImageObjectUrl } from "./image-object-url";
import { TtsArtifactPlayer } from "./TtsArtifactPlayer";
import "./generation-tools.css";

function desktopApi() {
  if (!window.eco) throw new Error(i18n.t("settings.tts.desktopOnly"));
  return window.eco;
}

type Artifact = ImageGenerationArtifact | TtsArtifact;
type Settings = ImageGenerationSettingsSnapshot | TtsSettingsSnapshot;
interface ToolApi<S extends Settings, A extends Artifact, I> {
  settings(): Promise<S>;
  list(scopeId: string): Promise<A[]>;
  subscribe(callback: (artifact: A) => void): () => void;
  create(request: GenerationToolRequest<I>): Promise<A>;
}
const imageApi: ToolApi<ImageGenerationSettingsSnapshot, ImageGenerationArtifact, ImageGenerationToolInput> =
  {
    settings: () => desktopApi().getImageGenerationSettings(),
    list: (id) => desktopApi().listImageGenerationArtifacts(id),
    subscribe: (callback) => desktopApi().onImageGenerationArtifactChanged(callback),
    create: (request) => desktopApi().createImageGeneration(request),
  };
const speechApi: ToolApi<TtsSettingsSnapshot, TtsArtifact, TtsToolInput> = {
  settings: () => desktopApi().getTtsSettings(),
  list: (id) => desktopApi().listTtsArtifacts(id),
  subscribe: (callback) => desktopApi().onTtsArtifactChanged(callback),
  create: (request) => desktopApi().createTts(request),
};

function mergeArtifacts<A extends Artifact>(current: A[], incoming: A[]): A[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = byId.get(item.id);
    if (
      !previous ||
      (item.updatedAt >= previous.updatedAt && !(previous.status !== "running" && item.status === "running"))
    )
      byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function useGenerationTool<S extends Settings, A extends Artifact, I>(
  api: ToolApi<S, A, I>,
  context: GenerationToolContext,
  active: boolean,
) {
  const scopeId = generationToolScopeId(context);
  const [settings, setSettings] = useState<S>();
  const [artifacts, setArtifacts] = useState<A[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextSettings, history] = await Promise.all([api.settings(), api.list(scopeId)]);
      if (!mounted.current) return;
      setSettings(nextSettings);
      setArtifacts((current) => mergeArtifacts(current, history));
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api, scopeId]);
  useEffect(() => {
    try {
      return api.subscribe((artifact) => {
        if (artifact.threadId === scopeId) setArtifacts((current) => mergeArtifacts(current, [artifact]));
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [api, scopeId]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const onFocus = () => {
      if (!busy.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refresh]);

  async function submit(input: I) {
    const profile = settings?.profiles.find((item) => item.id === settings.activeProfileId);
    if (busy.current || !settings || !profile) return;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const artifact = await api.create({
        context,
        profileId: profile.id,
        profileUpdatedAt: profile.updatedAt,
        input,
      });
      if (!mounted.current) return;
      setArtifacts((current) => mergeArtifacts(current, [artifact]));
      setExpandedIds((current) => new Set(current).add(artifact.id));
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      busy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  return {
    settings,
    artifacts,
    expandedIds,
    toggleExpanded(id: string) {
      setExpandedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    error,
    loading,
    refresh,
    submit,
    submitting,
    running: submitting || artifacts.some((item) => item.status === "running"),
  };
}

type Props = { context: GenerationToolContext; active: boolean; onOpenSettings(): void };

export function ImageGenerationToolPanel({ context, active, onOpenSettings }: Props) {
  const { t } = useTranslation();
  const tool = useGenerationTool(imageApi, context, active);
  const profile = tool.settings?.profiles.find((item) => item.id === tool.settings?.activeProfileId);
  const [prompt, setPrompt] = useState("");
  const [inputImages, setInputImages] = useState<{ path: string; name: string; previewUrl?: string }[]>([]);
  const [resolution, setResolution] = useState<ImageResolutionPreset | "">("");
  const [moreRatios, setMoreRatios] = useState(false);
  const referenceOperation = useRef(0);
  const ownedReferences = useRef(new Map<string, string>());
  const submission = useRef<Promise<void> | undefined>(undefined);
  const [size, setSize] = useState("");
  const [quality, setQuality] = useState<NonNullable<ImageGenerationToolInput["quality"]>>("auto");
  const [aspectRatio, setAspectRatio] = useState("");
  const [count, setCount] = useState(1);
  const [pickError, setPickError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const gemini = profile?.provider === "gemini";
  const customDimensions =
    !!profile &&
    (gemini ||
      profile.provider === "openai_compatible" ||
      profile.provider === "chatgpt_web" ||
      supportsCustomImageDimensions(profile.model));
  const preset =
    profile && resolution && aspectRatio
      ? imagePresetParameters(profile.provider, aspectRatio, resolution)
      : undefined;
  const invalidPreset =
    !!preset &&
    (profile?.provider === "openai" || profile?.provider === "codex") &&
    !isValidCustomImageSize(preset.size);
  const headerProfile = profile && {
    name: profile.name,
    model: profile.provider === "chatgpt_web" ? profile.chatModel : profile.model,
  };
  const id = useId();
  const profileKey = profile
    ? `${profile.id}:${profile.provider}:${profile.model}:${profile.supportsImageToImage}`
    : "";
  // Provider-specific controls start at their documented defaults after a profile switch.
  useEffect(() => {
    if (!profileKey) return;
    setSize("");
    setQuality("auto");
    setAspectRatio("");
    setCount(1);
    setInputImages([]);
    setResolution("");
    setPickError(undefined);
    setPicking(false);
    const owned = ownedReferences.current;
    return () => {
      referenceOperation.current++;
      const paths = [...owned.keys()];
      for (const url of owned.values()) revokeImageObjectUrl(url);
      owned.clear();
      // A request already using these files must finish before its inputs are released.
      void Promise.resolve(submission.current)
        .then(() => desktopApi().releasePromptImages({ paths }))
        .catch((error) => console.error("[generation] reference cleanup failed", error));
    };
  }, [profileKey]);
  // Focus refreshes keep the current form usable; disabling here would swallow the activating click.
  const disabled = tool.running || !tool.settings?.enabled || !profile || !context.workspacePath;
  async function addReferences(files?: File[]) {
    if (disabled || picking || !profile?.supportsImageToImage) return;
    const operation = ++referenceOperation.current;
    const currentOperation = () => operation === referenceOperation.current;
    const additions: typeof inputImages = [];
    setPickError(undefined);
    setPicking(true);
    try {
      const limit = gemini ? 3 : 16;
      if (files) {
        if (inputImages.length + files.length > limit)
          throw new Error(t("generation.imageLimit", { count: limit }));
        for (const file of files) {
          if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
            throw new Error(t("generation.referenceFormat"));
          if (file.size > COMPOSER_MAX_IMAGE_BYTES) throw new Error(t("generation.referenceSize"));
        }
        for (const file of files) {
          const image = await readImageFileAsAttachment(file);
          if (!image?.data) throw new Error(t("generation.referenceReadFailed"));
          let path: string;
          try {
            const staged = await desktopApi().stagePromptImage({
              contextKey: `landing:generation:${generationToolScopeId(context)}`,
              imageId: image.id,
              mediaType: image.mediaType,
              data: image.data,
            });
            path = staged.path;
          } catch (error) {
            revokeImageObjectUrl(image.previewUrl);
            throw error;
          }
          additions.push({ path, name: file.name, previewUrl: image.previewUrl });
          if (!currentOperation()) break;
        }
      } else {
        const paths = await desktopApi().pickImageGenerationInputs();
        const unique = [...new Set(paths)].filter(
          (path) => !inputImages.some((image) => image.path === path),
        );
        if (inputImages.length + unique.length > limit)
          throw new Error(t("generation.imageLimit", { count: limit }));
        additions.push(...unique.map((path) => ({ path, name: path.split(/[\\/]/).pop() || path })));
      }
      if (!currentOperation()) return;
      for (const image of additions)
        if (image.previewUrl) ownedReferences.current.set(image.path, image.previewUrl);
      setInputImages((current) => [...current, ...additions]);
    } catch (caught) {
      if (currentOperation()) setPickError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      // Discard incomplete batches and results arriving after a profile change/unmount.
      const discarded = additions.filter(
        (image) => image.previewUrl && !ownedReferences.current.has(image.path),
      );
      for (const image of discarded) revokeImageObjectUrl(image.previewUrl);
      if (discarded.length)
        void desktopApi()
          .releasePromptImages({ paths: discarded.map((image) => image.path) })
          .catch((error) => console.error("[generation] reference cleanup failed", error));
      if (currentOperation()) setPicking(false);
    }
  }
  function pasteImages(event: ClipboardEvent<HTMLElement>) {
    if (!active || disabled || !profile?.supportsImageToImage) return;
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void addReferences(files);
  }
  function removeReference(path: string) {
    const preview = ownedReferences.current.get(path);
    if (preview) {
      revokeImageObjectUrl(preview);
      ownedReferences.current.delete(path);
      void desktopApi()
        .releasePromptImages({ paths: [path] })
        .catch((error) => setPickError(error instanceof Error ? error.message : String(error)));
    }
    setInputImages((current) => current.filter((image) => image.path !== path));
  }
  return (
    <section
      className="generation-tool"
      aria-label={t("settings.imageGeneration.title")}
      onPaste={pasteImages}
    >
      <ToolHeader
        title={t("settings.imageGeneration.title")}
        profile={headerProfile}
        context={context}
        loading={tool.loading}
        onRefresh={() => void tool.refresh()}
        onOpenSettings={onOpenSettings}
      />
      {!context.workspacePath ? <p className="generation-notice">{t("generation.chooseProject")}</p> : null}
      {!tool.loading && !tool.settings?.enabled ? (
        <p className="generation-notice">{t("generation.enableImage")}</p>
      ) : null}
      <form
        className="generation-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !prompt.trim() || picking || invalidPreset) return;
          submission.current = tool.submit({
            prompt,
            ...(preset ?? (size ? { size } : {})),
            ...(gemini ? (aspectRatio ? { aspect_ratio: aspectRatio } : {}) : { quality }),
            count: gemini ? 1 : count,
            ...(inputImages.length ? { input_images: inputImages.map((image) => image.path) } : {}),
          });
        }}
      >
        <fieldset disabled={disabled}>
          <label htmlFor={`${id}-prompt`}>{t("generation.prompt")}</label>
          <textarea
            id={`${id}-prompt`}
            rows={5}
            maxLength={32000}
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("generation.promptPlaceholder")}
          />
          {customDimensions ? (
            <div className="generation-presets">
              <div className="generation-ratio-heading">
                <span id={`${id}-ratio-label`} className="generation-field-label">
                  {t("generation.aspectRatio")}
                </span>
                <button
                  type="button"
                  className="generation-ratio-default"
                  aria-pressed={!aspectRatio}
                  onClick={() => {
                    setAspectRatio("");
                    setResolution("");
                    setSize("");
                  }}
                >
                  {t("generation.providerDefault")}
                </button>
              </div>
              <fieldset className="generation-ratios" aria-labelledby={`${id}-ratio-label`}>
                {IMAGE_ASPECT_PRESETS.slice(0, moreRatios ? undefined : 5).map(({ ratio, label }) => (
                  <button
                    type="button"
                    key={ratio}
                    aria-pressed={aspectRatio === ratio}
                    onClick={() => {
                      setAspectRatio(ratio);
                      if (!resolution) setResolution("1080P");
                    }}
                  >
                    <span className="generation-ratio-icon" aria-hidden>
                      <span
                        style={{
                          aspectRatio: ratio.replace(":", "/"),
                          ...(Number(ratio.split(":")[0]) > Number(ratio.split(":")[1])
                            ? { width: 25 }
                            : { height: 25 }),
                        }}
                      />
                    </span>
                    <strong>{ratio}</strong>
                    <small>{t(`generation.ratio.${label}`)}</small>
                  </button>
                ))}
              </fieldset>
              <button
                type="button"
                className="generation-more-ratios"
                aria-expanded={moreRatios}
                onClick={() => setMoreRatios((current) => !current)}
              >
                {t(moreRatios ? "generation.lessRatios" : "generation.moreRatios")}
              </button>
              <label htmlFor={`${id}-resolution`}>{t("generation.resolution")}</label>
              <select
                id={`${id}-resolution`}
                value={resolution}
                onChange={(event) => {
                  const next = event.target.value as ImageResolutionPreset | "";
                  setResolution(next);
                  if (next && !aspectRatio) setAspectRatio("1:1");
                  if (!next && !gemini) setAspectRatio("");
                }}
              >
                <option value="">{t("generation.providerDefault")}</option>
                {IMAGE_RESOLUTION_PRESETS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              {preset ? (
                <p className="generation-size-hint" aria-live="polite">
                  {gemini
                    ? t("generation.geminiSize", { size: preset.size, ratio: aspectRatio })
                    : t("generation.actualSize", { size: preset.size.replace("x", " × ") })}
                  {!gemini ? <small>{t("generation.resolutionHint")}</small> : null}
                </p>
              ) : null}
              {invalidPreset ? (
                <p className="generation-error" role="alert">
                  {t("generation.unsupportedSize")}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="generation-options">
            {!resolution ? (
              <label htmlFor={`${id}-size`}>
                {t("generation.size")}
                {profile?.provider === "openai_compatible" || profile?.provider === "chatgpt_web" ? (
                  <input
                    id={`${id}-size`}
                    value={size}
                    onChange={(event) => setSize(event.target.value)}
                    placeholder="auto / 1024x1024"
                  />
                ) : (
                  <select id={`${id}-size`} value={size} onChange={(event) => setSize(event.target.value)}>
                    <option value="">{t("generation.providerDefault")}</option>
                    {(gemini ? ["1K", "2K", "4K"] : ["auto", "1024x1024", "1536x1024", "1024x1536"]).map(
                      (value) => (
                        <option key={value}>{value}</option>
                      ),
                    )}
                  </select>
                )}
              </label>
            ) : null}
            {!gemini ? (
              <>
                <label>
                  {t("generation.quality")}
                  <select
                    value={quality}
                    onChange={(event) => setQuality(event.target.value as typeof quality)}
                  >
                    {["auto", "low", "medium", "high"].map((value) => (
                      <option key={value} value={value}>
                        {t(`generation.quality.${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("generation.count")}
                  <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                    {[1, 2, 3, 4].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>
          {profile?.supportsImageToImage ? (
            <div className="generation-references">
              <button
                type="button"
                className="settings-secondary-button"
                disabled={picking}
                onClick={() => void addReferences()}
              >
                <ImagePlus size={14} aria-hidden />
                {t("generation.references")}
              </button>
              <p className="generation-reference-hint">{t("generation.pasteHint")}</p>
              {inputImages.map(({ path, name, previewUrl }) => (
                <span className="generation-reference" key={path} title={path}>
                  {previewUrl ? <img src={previewUrl} alt={name} /> : null}
                  <span>{name}</span>
                  <button
                    type="button"
                    aria-label={t("generation.removeReference", { name })}
                    disabled={picking}
                    onClick={() => removeReference(path)}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </fieldset>
        {tool.error || pickError ? (
          <p className="generation-error" role="alert">
            {tool.error || pickError}
          </p>
        ) : null}
        <button
          className="settings-primary-button generation-submit"
          type="submit"
          disabled={disabled || !prompt.trim() || picking || invalidPreset}
        >
          {tool.running ? (
            <LoaderCircle size={15} className="generation-spinner" aria-hidden />
          ) : (
            <WandSparkles size={15} aria-hidden />
          )}
          {t(tool.running ? "generation.generating" : "generation.createImage")}
        </button>
      </form>
      <ToolHistory
        artifacts={tool.artifacts}
        expandedIds={tool.expandedIds}
        onToggle={tool.toggleExpanded}
        renderDetail={(artifact) => <ImageGenerationArtifactDetail artifact={artifact} />}
      />
    </section>
  );
}

export function SpeechGenerationToolPanel({ context, active, onOpenSettings }: Props) {
  const { t } = useTranslation();
  const tool = useGenerationTool(speechApi, context, active);
  const profile = tool.settings?.profiles.find((item) => item.id === tool.settings?.activeProfileId);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [style, setStyle] = useState(() => t("generation.defaultStyle"));
  const id = useId();
  const provider = profile?.provider;
  useEffect(() => {
    setVoice(provider ? defaultReadAloudVoice(provider) : "");
  }, [provider]);
  const disabled =
    tool.loading || tool.running || !tool.settings?.enabled || !profile || !context.workspacePath;
  const voices =
    profile?.provider === "doubao"
      ? [
          "zh_female_vv_uranus_bigtts",
          "zh_female_xiaohe_uranus_bigtts",
          "zh_male_m191_uranus_bigtts",
          "zh_female_qingxinnvsheng_uranus_bigtts",
          "en_male_tim_uranus_bigtts",
          "en_female_dacey_uranus_bigtts",
        ]
      : profile?.provider === "gemini"
        ? ["Kore", "Puck", "Aoede", "Charon", "Fenrir", "Leda", "Orus", "Zephyr"]
        : [];
  return (
    <section className="generation-tool" aria-label={t("settings.tts.title")}>
      <ToolHeader
        title={t("settings.tts.title")}
        profile={profile}
        context={context}
        loading={tool.loading}
        onRefresh={() => void tool.refresh()}
        onOpenSettings={onOpenSettings}
      />
      {!context.workspacePath ? <p className="generation-notice">{t("generation.chooseProject")}</p> : null}
      {!tool.loading && !tool.settings?.enabled ? (
        <p className="generation-notice">{t("generation.enableSpeech")}</p>
      ) : null}
      <form
        className="generation-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && text.trim() && voice.trim() && style.trim())
            void tool.submit({ text, voice, style });
        }}
      >
        <fieldset disabled={disabled}>
          <label htmlFor={`${id}-text`}>{t("generation.transcript")}</label>
          <textarea
            id={`${id}-text`}
            rows={5}
            maxLength={32000}
            required
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("generation.transcriptPlaceholder")}
          />
          <label htmlFor={`${id}-voice`}>{t("generation.voice")}</label>
          <input
            id={`${id}-voice`}
            list={`${id}-voices`}
            value={voice}
            maxLength={256}
            required
            onChange={(event) => setVoice(event.target.value)}
            placeholder={t("generation.voicePlaceholder")}
          />
          <datalist id={`${id}-voices`}>
            {voices.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <label htmlFor={`${id}-style`}>{t("task.tts.style")}</label>
          <textarea
            id={`${id}-style`}
            rows={2}
            maxLength={4000}
            required
            value={style}
            onChange={(event) => setStyle(event.target.value)}
          />
        </fieldset>
        {tool.error ? (
          <p className="generation-error" role="alert">
            {tool.error}
          </p>
        ) : null}
        <button
          className="settings-primary-button generation-submit"
          type="submit"
          disabled={disabled || !text.trim() || !voice.trim() || !style.trim()}
        >
          {tool.running ? (
            <LoaderCircle size={15} className="generation-spinner" aria-hidden />
          ) : (
            <WandSparkles size={15} aria-hidden />
          )}
          {t(tool.running ? "generation.generating" : "generation.createSpeech")}
        </button>
      </form>
      <ToolHistory
        artifacts={tool.artifacts}
        expandedIds={tool.expandedIds}
        onToggle={tool.toggleExpanded}
        renderDetail={(artifact) => <TtsArtifactPlayer artifact={artifact} />}
      />
    </section>
  );
}

function ToolHeader({
  title,
  profile,
  context,
  loading,
  onRefresh,
  onOpenSettings,
}: {
  title: string;
  profile: { name: string; model: string } | undefined;
  context: GenerationToolContext;
  loading: boolean;
  onRefresh(): void;
  onOpenSettings(): void;
}) {
  const { t } = useTranslation();
  return (
    <header className="generation-header">
      <div>
        <h2>{title}</h2>
        <p>{profile ? `${profile.name} · ${profile.model}` : t("generation.configure")}</p>
        <span className="generation-scope">
          {t(context.threadId ? "generation.savedToConversation" : "generation.savedToProject")}
        </span>
      </div>
      <div className="generation-header-actions">
        <button
          type="button"
          disabled={loading}
          onClick={onRefresh}
          aria-label={t("generation.refresh")}
          title={t("generation.refresh")}
        >
          <RefreshCw size={15} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("generation.settings")}
          title={t("generation.settings")}
        >
          <Settings2 size={15} aria-hidden />
        </button>
      </div>
    </header>
  );
}

function ToolHistory<A extends Artifact>({
  artifacts,
  expandedIds,
  onToggle,
  renderDetail,
}: {
  artifacts: A[];
  expandedIds: ReadonlySet<string>;
  onToggle(id: string): void;
  renderDetail(artifact: A): ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  return (
    <section className="generation-history" aria-label={t("generation.history")}>
      <h3>{t("generation.history")}</h3>
      {artifacts.length ? (
        <div className="generation-history-list">
          {artifacts.map((artifact) => {
            const expanded = expandedIds.has(artifact.id);
            const detailId = `${id}-${artifact.id}`;
            return (
              <div className="generation-history-item" key={artifact.id}>
                <button
                  type="button"
                  className="generation-history-toggle"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  onClick={() => onToggle(artifact.id)}
                >
                  <ChevronRight size={14} className="generation-history-chevron" aria-hidden />
                  <span className="generation-history-text">
                    {"prompt" in artifact ? artifact.prompt : artifact.text}
                  </span>
                  <span className={`generation-history-status is-${artifact.status}`}>
                    {t(`task.image.status.${artifact.status}`)}
                  </span>
                  <time dateTime={artifact.createdAt}>
                    {new Date(artifact.createdAt).toLocaleString(i18n.language)}
                  </time>
                </button>
                <div id={detailId} className="generation-history-detail" hidden={!expanded}>
                  {expanded ? renderDetail(artifact) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="generation-empty">{t("generation.empty")}</p>
      )}
    </section>
  );
}
