import { ChevronDown, ChevronUp } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isEcoTtsToolName, type TtsArtifact } from "../shared/tts";
import { dispatchWorkspaceFileReference } from "./workspace-file-reference";
import "./tts.css";

export const TtsArtifactsContext = createContext<readonly TtsArtifact[]>([]);
export const TtsFeedGroupDetailsContext = createContext(false);

export function TtsArtifactPlayer({
  artifact,
  onOpen,
  compact = false,
}: {
  artifact: TtsArtifact;
  onOpen?: (id: string) => void;
  /** Feed / floating cards show only the audio bar; details expand in place. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const mounted = useRef(true);
  const autoplay = useRef(false);
  const busy = useRef(false);
  const objectUrl = useRef<string | undefined>(undefined);
  const playable = artifact.status === "completed" && artifact.audio.length > 0;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  const loadAudio = useCallback(
    async (autoplayAfterLoad: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      setError(undefined);
      autoplay.current = autoplayAfterLoad;
      try {
        if (!window.eco?.readTtsArtifact) throw new Error(t("settings.tts.desktopOnly"));
        const result = await window.eco.readTtsArtifact({ artifactId: artifact.id, audioIndex: 0 });
        if (!mounted.current) return;
        const data = Uint8Array.from(atob(result.dataBase64), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([data], { type: result.mimeType }));
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = url;
        setSource(url);
      } catch (caught) {
        if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        busy.current = false;
        if (mounted.current) setLoading(false);
      }
    },
    [artifact.id, t],
  );

  // Compact cards are the audio bar itself, so the bar is ready without a click. The Feed list is
  // virtualized, which keeps this to the artifacts the user can actually see.
  const eagerLoadStarted = useRef(false);
  useEffect(() => {
    if (!compact || !playable || eagerLoadStarted.current) return;
    eagerLoadStarted.current = true;
    void loadAudio(false);
  }, [compact, playable, loadAudio]);

  useEffect(() => {
    if (!source || !player.current || !autoplay.current) return;
    autoplay.current = false;
    void player.current.play().catch((caught) => {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [source]);

  function openAudioInFileViewer(): void {
    const path = artifact.audio[0]?.absolutePath;
    if (path) dispatchWorkspaceFileReference({ path });
  }

  function revealAudio(): void {
    if (!window.eco?.revealTtsArtifact) {
      setError(t("settings.tts.desktopOnly"));
      return;
    }
    window.eco.revealTtsArtifact({ artifactId: artifact.id, audioIndex: 0 }).catch((caught: unknown) => {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    });
  }

  const details = (
    <>
      <div className="tts-artifact-head">
        <div className="tts-artifact-player-meta">
          <span className="tts-artifact-status">{t(`task.tts.status.${artifact.status}`)}</span>
          <span className="tts-artifact-model" title={artifact.model}>
            {artifact.model}
          </span>
        </div>
        {/* Voice IDs carry their meaning in the middle (`zh_female_<name>_uranus_bigtts`), so the ID
            gets the whole row instead of sharing a line with status and model. */}
        <div className="tts-artifact-voice" title={artifact.parameters.voice}>
          {artifact.parameters.voice}
        </div>
      </div>
      <p className="tts-artifact-transcript">{artifact.text}</p>
      <details>
        <summary>{t("task.tts.style")}</summary>
        <p>{artifact.parameters.style}</p>
      </details>
      {artifact.audio.length > 0 ? (
        <div className="tts-artifact-player-actions">
          {onOpen ? (
            <button type="button" className="settings-secondary-button" onClick={() => onOpen(artifact.id)}>
              {t("task.tts.details")}
            </button>
          ) : null}
          <button type="button" className="settings-secondary-button" onClick={openAudioInFileViewer}>
            {t("task.tts.openInFileViewer")}
          </button>
          <button type="button" className="settings-secondary-button" onClick={revealAudio}>
            {t("task.tts.reveal")}
          </button>
        </div>
      ) : null}
    </>
  );

  const audioBar = playable ? (
    source ? (
      // biome-ignore lint/a11y/useMediaCaption: The verbatim transcript is listed in the details block.
      <audio
        ref={player}
        controls
        preload="none"
        src={source}
        onError={() => setError(t("task.tts.playbackError"))}
      />
    ) : (
      <button
        type="button"
        className="settings-secondary-button tts-artifact-play"
        disabled={loading}
        onClick={() => void loadAudio(true)}
      >
        {t(loading ? "task.tts.loading" : "task.tts.play")}
      </button>
    )
  ) : (
    <span className="tts-artifact-status">{t(`task.tts.status.${artifact.status}`)}</span>
  );

  const providerError = artifact.errorMessage ? (
    <p role="alert" className="browser-settings-error">
      {artifact.errorCode}: {artifact.errorMessage}
    </p>
  ) : null;
  // Load / playback problems must stay visible on the collapsed bar, unlike generation detail.
  const localError = error ? (
    <p role="alert" className="browser-settings-error">
      {error}
    </p>
  ) : null;

  if (!compact) {
    return (
      <article className="tts-artifact-player" aria-label={t("settings.tts.title")}>
        {details}
        {audioBar}
        {providerError}
        {localError}
      </article>
    );
  }

  return (
    <article
      className="tts-artifact-player is-compact"
      aria-label={t("settings.tts.title")}
      data-expanded={expanded || undefined}
    >
      <div className="tts-artifact-bar">
        {audioBar}
        <button
          type="button"
          className="tts-artifact-toggle"
          aria-expanded={expanded}
          aria-label={t(expanded ? "task.tts.collapse" : "task.tts.details")}
          title={t(expanded ? "task.tts.collapse" : "task.tts.details")}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronUp size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
        </button>
      </div>
      {artifact.status !== "completed" ? providerError : null}
      {localError}
      {expanded ? details : null}
    </article>
  );
}

/** Works for both full tool metadata and V2 skeleton rows; no Feed detail fetch required. */
export function readTtsToolUseId(item: {
  metadata?: Record<string, unknown> | undefined;
}): string | undefined {
  const tool = item.metadata?.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const record = tool as Record<string, unknown>;
  return typeof record.name === "string" &&
    isEcoTtsToolName(record.name) &&
    typeof record.toolUseId === "string"
    ? record.toolUseId
    : undefined;
}

export function TtsFeedArtifacts({ toolUseIds }: { toolUseIds: readonly string[] }) {
  const artifacts = useContext(TtsArtifactsContext);
  const groupDetails = useContext(TtsFeedGroupDetailsContext);
  if (groupDetails) return null;
  const ids = new Set(toolUseIds);
  const matches = artifacts.filter((artifact) => artifact.toolUseId && ids.has(artifact.toolUseId));
  return matches.length > 0 ? (
    <div className="tts-feed-artifacts">
      {matches.map((artifact) => (
        <TtsArtifactPlayer key={artifact.id} artifact={artifact} compact />
      ))}
    </div>
  ) : null;
}
