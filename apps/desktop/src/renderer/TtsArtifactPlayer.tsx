import { ArrowUpRight, LoaderCircle, Pause, Play } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isEcoTtsToolName, type TtsArtifact } from "../shared/tts";
import { dispatchWorkspaceFileReference } from "./workspace-file-reference";
import "./tts.css";

export const TtsArtifactsContext = createContext<readonly TtsArtifact[]>([]);
export const OpenTtsArtifactContext = createContext<((id: string) => void) | undefined>(undefined);

export function TtsArtifactPlayer({
  artifact,
  onOpen,
  compact = false,
  showTranscriptPreview = false,
}: {
  artifact: TtsArtifact;
  onOpen?: (id: string) => void;
  /** Feed / floating cards keep details in the task sidebar. */
  compact?: boolean;
  /** Feed cards show a three-line excerpt above the playback bar. */
  showTranscriptPreview?: boolean;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const openArtifact = useContext(OpenTtsArtifactContext);
  const openDetails = onOpen ?? openArtifact;
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [currentTime, setCurrentTime] = useState(0);
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

  // Read visible players' metadata so duration and seeking are ready before playback.
  // Collapsed Feed tool groups do not mount their players.
  const eagerLoadStarted = useRef(false);
  useEffect(() => {
    if (!playable || eagerLoadStarted.current) return;
    eagerLoadStarted.current = true;
    void loadAudio(false);
  }, [playable, loadAudio]);

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
      <div className="tts-artifact-style">
        <span className="tts-artifact-model">{t("task.tts.style")}</span>
        <p>{artifact.parameters.style}</p>
      </div>
      {artifact.audio.length > 0 ? (
        <div className="tts-artifact-player-actions">
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

  async function togglePlayback() {
    if (!source) {
      await loadAudio(true);
      return;
    }
    const audio = player.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const audioBar = (
    <div className="tts-artifact-bar">
      {playable ? (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: The transcript is available in the artifact sidebar. */}
          <audio
            ref={player}
            preload="metadata"
            src={source}
            onLoadedMetadata={(event) => {
              const value = event.currentTarget.duration;
              setDuration(Number.isFinite(value) && value > 0 ? value : undefined);
            }}
            onDurationChange={(event) => {
              const value = event.currentTarget.duration;
              setDuration(Number.isFinite(value) && value > 0 ? value : undefined);
            }}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setError(t("task.tts.playbackError"))}
          />
          <button
            type="button"
            className="tts-artifact-play"
            disabled={loading}
            aria-label={t(loading ? "task.tts.loading" : playing ? "task.tts.pause" : "task.tts.play")}
            title={t(playing ? "task.tts.pause" : "task.tts.play")}
            onClick={() => void togglePlayback()}
          >
            {loading ? (
              <LoaderCircle size={15} className="tts-artifact-spinner" aria-hidden />
            ) : playing ? (
              <Pause size={15} fill="currentColor" aria-hidden />
            ) : (
              <Play size={15} fill="currentColor" aria-hidden />
            )}
          </button>
          <input
            className="tts-artifact-progress"
            type="range"
            min={0}
            max={duration ?? 0}
            step={0.1}
            value={currentTime}
            disabled={!duration}
            aria-label={t("task.tts.progress")}
            aria-valuetext={`${formatAudioTime(currentTime)} / ${formatAudioTime(duration)}`}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (player.current) player.current.currentTime = value;
              setCurrentTime(value);
            }}
          />
          <span className="tts-artifact-time">
            {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
          </span>
        </>
      ) : (
        <span className="tts-artifact-status">{t(`task.tts.status.${artifact.status}`)}</span>
      )}
      {compact && openDetails ? (
        <button
          type="button"
          className="tts-artifact-details"
          aria-label={t("task.tts.details")}
          title={t("task.tts.details")}
          onClick={() => openDetails(artifact.id)}
        >
          <ArrowUpRight size={15} aria-hidden />
        </button>
      ) : null}
    </div>
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
    <article className="tts-artifact-player is-compact" aria-label={t("settings.tts.title")}>
      {showTranscriptPreview ? <p className="tts-artifact-transcript-preview">{artifact.text}</p> : null}
      {audioBar}
      {artifact.status !== "completed" ? providerError : null}
      {localError}
    </article>
  );
}

function formatAudioTime(seconds: number | undefined): string {
  if (seconds === undefined) return "--:--";
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
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
  const ids = new Set(toolUseIds);
  const matches = artifacts.filter((artifact) => artifact.toolUseId && ids.has(artifact.toolUseId));
  return matches.length > 0 ? (
    <div className="tts-feed-artifacts">
      {matches.map((artifact) => (
        <TtsArtifactPlayer key={artifact.id} artifact={artifact} compact showTranscriptPreview />
      ))}
    </div>
  ) : null;
}
